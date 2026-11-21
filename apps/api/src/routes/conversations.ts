import {
  attachment,
  bot,
  conversation,
  database,
  findWorkspace,
  message,
  newId,
  run,
  RUN_QUEUE,
  startBoss,
} from "@terabot/db";
import type { RunComputer } from "@terabot/agent";
import type { MessagePart } from "@terabot/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.ts";

const attachmentRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mime: z.string().min(1).max(255),
});

const sendMessageSchema = z
  .object({
    text: z.string().trim().max(8000).default(""),
    attachments: z.array(attachmentRef).max(8).optional(),
    quote: z.object({ messageId: z.string().min(1), text: z.string().max(2000) }).optional(),
  })
  .refine((value) => value.text.length > 0 || (value.attachments?.length ?? 0) > 0, {
    message: "a message needs text or a file",
  });

/** Raised inside the send transaction when a requested file cannot be claimed. */
class UnclaimableAttachment extends Error {}

export interface EnqueueRequest {
  runId: string;
  /** Keeps the work alive after the response on a serverless runtime. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Wakes and leases the bot's computer; without one a run never touches a machine. */
  computer?: RunComputer;
}

export type EnqueueRun = (job: EnqueueRequest) => Promise<void>;

function keepAlive(c: Context<AppEnv>): EnqueueRequest["waitUntil"] {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    // @hono/node-server has no execution context; the process outlives the
    // request anyway, so the run just continues on its own.
    return undefined;
  }
}

let bossPromise: ReturnType<typeof startBoss> | undefined;

async function enqueueWithQueue({ runId }: EnqueueRequest): Promise<void> {
  bossPromise ??= startBoss();
  const queue = await bossPromise;
  await queue.send(RUN_QUEUE, { runId }, { retryLimit: 2, expireInSeconds: 300 });
}

interface ConversationScope {
  conversationId: string;
  botId: string;
  workspaceId: string;
}

async function scopeConversation(userId: string, conversationId: string): Promise<ConversationScope | null> {
  const workspace = await findWorkspace(userId);
  if (!workspace) return null;
  const rows = await database()
    .select({ conversationId: conversation.id, botId: bot.id, workspaceId: bot.workspaceId })
    .from(conversation)
    .innerJoin(bot, eq(conversation.botId, bot.id))
    .where(and(eq(conversation.id, conversationId), eq(bot.workspaceId, workspace.id)))
    .limit(1);
  return rows[0] ?? null;
}

export function createConversationRoutes(options: { enqueue?: EnqueueRun } = {}) {
  const enqueue = options.enqueue ?? enqueueWithQueue;
  return new Hono<AppEnv>()
  .get("/conversations/:id/messages", async (c) => {
    const scope = await scopeConversation(c.get("user").id, c.req.param("id"));
    if (!scope) return c.json({ error: "not_found" }, 404);

    const messages = await database()
      .select()
      .from(message)
      .where(eq(message.conversationId, scope.conversationId))
      .orderBy(asc(message.createdAt));
    return c.json({ messages });
  })
  .get("/conversations/:id/state", async (c) => {
    const scope = await scopeConversation(c.get("user").id, c.req.param("id"));
    if (!scope) return c.json({ error: "not_found" }, 404);

    const db = database();
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, scope.conversationId))
      .orderBy(asc(message.createdAt));

    const active = await db
      .select()
      .from(run)
      .where(and(eq(run.conversationId, scope.conversationId), inArray(run.status, ["queued", "running"])))
      .orderBy(desc(run.createdAt))
      .limit(1);

    const activeRun = active[0];
    return c.json({
      messages,
      activeRun: activeRun ? { id: activeRun.id, status: activeRun.status } : null,
    });
  })
  .post("/conversations/:id/messages", async (c) => {
    const scope = await scopeConversation(c.get("user").id, c.req.param("id"));
    if (!scope) return c.json({ error: "not_found" }, 404);

    const parsed = sendMessageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    const db = database();
    const { text, quote, attachments = [] } = parsed.data;

    const messageId = newId();
    const runId = newId();
    const attachmentIds = attachments.map((file) => file.id);

    // A message during a run never queues behind it: the in-flight step stops
    // and keeps its partial output, then this message starts the next run.
    const inFlight = await db
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.conversationId, scope.conversationId), inArray(run.status, ["queued", "running"])))
      .limit(1);

    try {
      await db.transaction(async (tx) => {
        if (inFlight[0]) {
          await tx.update(run).set({ abortRequested: true }).where(eq(run.id, inFlight[0].id));
        }

        const parts: MessagePart[] = [];
        if (quote) parts.push({ type: "quote", messageId: quote.messageId, text: quote.text });
        if (text) parts.push({ type: "text", text });
        for (const file of attachments) {
          parts.push({ type: "file", attachmentId: file.id, name: file.name, size: file.size, mime: file.mime });
        }

        await tx.insert(message).values({
          id: messageId,
          conversationId: scope.conversationId,
          role: "user",
          parts,
          status: "complete",
        });
        await tx.insert(run).values({
          id: runId,
          conversationId: scope.conversationId,
          botId: scope.botId,
          status: "queued",
        });

        // A file may only join a message in the workspace that uploaded it, and
        // only while nobody else has claimed it: an upload id from another
        // account is not enough to adopt the bytes it names.
        const claimed =
          attachmentIds.length === 0
            ? []
            : await tx
                .update(attachment)
                .set({ messageId })
                .where(
                  and(
                    inArray(attachment.id, attachmentIds),
                    isNull(attachment.messageId),
                    eq(attachment.workspaceId, scope.workspaceId),
                  ),
                )
                .returning({ id: attachment.id });
        if (claimed.length !== attachmentIds.length) throw new UnclaimableAttachment();

        await tx
          .update(conversation)
          .set({
            lastMessagePreview: (text || attachments[0]?.name || "").slice(0, 160),
            updatedAt: new Date(),
          })
          .where(eq(conversation.id, scope.conversationId));
        await tx.update(bot).set({ unread: false }).where(eq(bot.id, scope.botId));
      });
    } catch (error) {
      if (error instanceof UnclaimableAttachment) {
        return c.json(
          { error: "invalid_attachment", detail: "a file is missing, already sent, or belongs to another workspace" },
          400,
        );
      }
      throw error;
    }

    await enqueue({ runId, waitUntil: keepAlive(c) });

    return c.json({ messageId, runId, interruptedRunId: inFlight[0]?.id ?? null }, 201);
  });
}
