import {
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
import type { MessagePart } from "@terabot/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.ts";

const sendMessageSchema = z.object({
  text: z.string().trim().min(1, "a message needs text").max(8000),
  quote: z.object({ messageId: z.string().min(1), text: z.string().max(2000) }).optional(),
});

export type EnqueueRun = (runId: string) => Promise<void>;

let bossPromise: ReturnType<typeof startBoss> | undefined;

async function enqueueWithQueue(runId: string): Promise<void> {
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
    const { text, quote } = parsed.data;

    const parts: MessagePart[] = [];
    if (quote) parts.push({ type: "quote", messageId: quote.messageId, text: quote.text });
    parts.push({ type: "text", text });

    const messageId = newId();
    const runId = newId();

    // A message during a run never queues behind it: the in-flight step stops
    // and keeps its partial output, then this message starts the next run.
    const inFlight = await db
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.conversationId, scope.conversationId), inArray(run.status, ["queued", "running"])))
      .limit(1);

    await db.transaction(async (tx) => {
      if (inFlight[0]) {
        await tx.update(run).set({ abortRequested: true }).where(eq(run.id, inFlight[0].id));
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
      await tx
        .update(conversation)
        .set({ lastMessagePreview: text.slice(0, 160), updatedAt: new Date() })
        .where(eq(conversation.id, scope.conversationId));
      await tx.update(bot).set({ unread: false }).where(eq(bot.id, scope.botId));
    });

    await enqueue(runId);

    return c.json({ messageId, runId, interruptedRunId: inFlight[0]?.id ?? null }, 201);
  });
}
