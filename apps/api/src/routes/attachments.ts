import { attachment, bot, conversation, database, findWorkspace, message, newId } from "@pupbot/db";
import { attachmentStore } from "@pupbot/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

/** Vercel caps a function request body at 4.5 MB, so stay under it. */
const MAX_BYTES = 4 * 1024 * 1024;

function safeName(raw: string): string {
  return raw.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 255) || "file";
}

export const attachmentRoutes = new Hono<AppEnv>()
  /**
   * Upload one file. The row is created first so the browser has an id to send
   * with the message; the bytes go to whichever store is configured.
   */
  .post("/attachments", async (c) => {
    const workspace = await findWorkspace(c.get("user").id);
    if (!workspace) return c.json({ error: "not_found" }, 404);

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) return c.json({ error: "invalid_body", detail: "file is required" }, 400);
    if (file.size === 0) return c.json({ error: "invalid_body", detail: "file is empty" }, 400);
    if (file.size > MAX_BYTES) {
      return c.json({ error: "too_large", detail: `files must be under ${MAX_BYTES} bytes` }, 413);
    }

    const id = newId();
    const name = safeName(file.name);
    const mime = file.type || "application/octet-stream";
    const bytes = Buffer.from(await file.arrayBuffer());

    await database().insert(attachment).values({
      id,
      storageKey: id,
      name,
      size: bytes.byteLength,
      mime,
    });

    try {
      await attachmentStore().put(id, bytes, mime);
    } catch (error) {
      console.error("[attachments] put failed", error);
      await database().delete(attachment).where(eq(attachment.id, id));
      return c.json({ error: "storage_failed" }, 502);
    }

    return c.json(
      { id, name, size: bytes.byteLength, mime, driver: attachmentStore().driver },
      201,
    );
  })
  /**
   * Download a file that belongs to a message in the caller's workspace. An
   * upload that was never sent has no message, so it is not readable here.
   */
  .get("/attachments/:id", async (c) => {
    const workspace = await findWorkspace(c.get("user").id);
    if (!workspace) return c.json({ error: "not_found" }, 404);

    const rows = await database()
      .select({ storageKey: attachment.storageKey, name: attachment.name, mime: attachment.mime })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(bot, eq(bot.id, conversation.botId))
      .where(and(eq(attachment.id, c.req.param("id")), eq(bot.workspaceId, workspace.id)))
      .limit(1);

    const row = rows[0];
    if (!row) return c.json({ error: "not_found" }, 404);

    const bytes = await attachmentStore().read(row.storageKey);
    if (!bytes) return c.json({ error: "not_found" }, 404);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": row.mime,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="${row.name.replace(/"/g, "")}"`,
        "cache-control": "private, max-age=3600",
      },
    });
  });
