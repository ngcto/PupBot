import { attachment, bot, conversation, database, findWorkspace, message, newId } from "@terabot/db";
import { StorageBackendUnavailable, attachmentStore, storageKeyFor } from "@terabot/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

/** Vercel caps a function request body at 4.5 MB, so stay under it. */
const MAX_BYTES = 4 * 1024 * 1024;

function safeName(raw: string): string {
  return raw.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 255) || "file";
}

/**
 * Types a browser may open without executing anything. Markup and SVG are not
 * on the list: the download is served from the app's own origin, so an inline
 * document would run with the session's authority.
 */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
]);

/** RFC 6266: a plain name for old clients, `filename*` so any name survives. */
function disposition(name: string, mime: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name);
  const kind = INLINE_TYPES.has(mime.toLowerCase()) ? "inline" : "attachment";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
      workspaceId: workspace.id,
      storageKey: storageKeyFor(attachmentStore().driver, id),
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

    let bytes: Buffer | null;
    try {
      bytes = await attachmentStore().read(row.storageKey);
    } catch (error) {
      if (error instanceof StorageBackendUnavailable) {
        // The row is real and the bytes exist: the deployment lost the
        // credentials for the backend they were written to.
        console.error("[attachments] backend unavailable", error.message);
        return c.json({ error: "storage_unavailable" }, 503);
      }
      throw error;
    }
    if (!bytes) return c.json({ error: "not_found" }, 404);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": row.mime,
        "content-length": String(bytes.byteLength),
        "content-disposition": disposition(row.name, row.mime),
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
      },
    });
  });
