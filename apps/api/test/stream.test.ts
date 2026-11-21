import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { executeRun } from "@terabot/agent";
import {
  auth,
  bot,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  message,
  modelEndpoint,
  newId,
  run,
  runEvent,
  user,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import type { ModelGateway } from "@terabot/providers";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

/** Streams a few words with a gap, so a second message can land mid-sentence. */
function slowGateway(words: string[], gapMs: number): ModelGateway {
  return {
    async *stream() {
      for (const word of words) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        yield { type: "text_delta" as const, text: `${word} ` };
      }
      yield { type: "usage" as const, inputTokens: 11, outputTokens: 7 };
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a condition instead of a fixed sleep: on a busy CI box the run can
 * take longer than any hard-coded delay to emit its first delta, and an
 * interrupt that lands before that legitimately has no partial text.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for the run to start streaming");
}

describe("conversation run protocol", () => {
  let app: ReturnType<typeof createApp>;
  let db: Database;
  const email = `stream-${Date.now()}@terabot.dev`;
  let cookie = "";
  let conversationId = "";
  let botId = "";

  beforeAll(async () => {
    app = createApp({ enqueue: async () => {} });
    db = database();
    const signUp = await auth().api.signUpEmail({
      body: { email, password: "stream-test-password", name: "Stream Test" },
      returnHeaders: true,
    });
    cookie = signUp.headers.get("set-cookie")?.split(";")[0] ?? "";
    const created = signUp.response.user;
    const space = await ensureWorkspace(created.id, "Stream Test");

    const endpointId = newId();
    await db.insert(modelEndpoint).values({
      id: endpointId,
      workspaceId: space.id,
      kind: "openai-chat",
      label: "test endpoint",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "test-model",
      catalogMatch: "unmatched",
    });

    botId = newId();
    conversationId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId: space.id,
      name: "Test Tera",
      avatar: { shape: "mug", color: "amber" },
      accentColor: "#f69412",
      instructions: "Test bot.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Test" });
  }, 30_000);

  afterAll(async () => {
    if (db) await db.delete(user).where(eq(user.email, email));
    await closeDatabase();
  });

  it("streams a reply and replays it from a sequence number", async () => {
    const sent = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello there" }),
    });
    expect(sent.status).toBe(201);
    const { runId } = (await sent.json()) as { runId: string };

    const outcome = await executeRun({
      db,
      gateway: slowGateway(["Woof", "back"], 5),
      runId,
      abortPollMs: 20,
    });
    expect(outcome.status).toBe("done");

    const all = await db
      .select()
      .from(runEvent)
      .where(eq(runEvent.runId, runId))
      .orderBy(asc(runEvent.seq));
    const seqs = all.map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));

    const replay = await app.request(`/runs/${runId}/events?after=2`, { headers: { cookie } });
    expect(replay.status).toBe(200);
    const body = await replay.text();
    expect(body).toContain("event: done");
    expect(body).not.toContain('"seq":1,');

    // The client renders the reply from `message.completed`, so the replay must
    // carry it, and the stream must not close before it.
    const completedAt = body.indexOf("event: message.completed");
    const doneAt = body.indexOf("event: done");
    expect(completedAt).toBeGreaterThan(-1);
    expect(doneAt).toBeGreaterThan(completedAt);
    const firstReplayed = body.match(/"seq":(\d+)/)?.[1];
    expect(Number(firstReplayed)).toBe(3);

    const state = await app.request(`/conversations/${conversationId}/state`, { headers: { cookie } });
    const parsed = (await state.json()) as { messages: Array<{ role: string; parts: { text?: string }[] }> };
    const assistant = parsed.messages.filter((entry) => entry.role === "assistant").at(-1);
    expect(assistant?.parts[0]?.text).toBe("Woof back ");
  }, 30_000);

  it("aborts the in-flight run on a new message, keeps the partial text, and starts a new run", async () => {
    const first = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "count to a hundred" }),
    });
    const firstRun = (await first.json()) as { runId: string };

    const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
    const running = executeRun({
      db,
      gateway: slowGateway(words, 40),
      runId: firstRun.runId,
      abortPollMs: 20,
    });

    await waitFor(async () => {
      const rows = await db
        .select({ seq: runEvent.seq })
        .from(runEvent)
        .where(and(eq(runEvent.runId, firstRun.runId), eq(runEvent.type, "text_delta")))
        .limit(1);
      return rows.length > 0;
    });
    // Let a couple more words land so the partial answer is clearly shorter.
    await sleep(80);

    const second = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "stop, do something else" }),
    });
    expect(second.status).toBe(201);
    const secondRun = (await second.json()) as { runId: string; interruptedRunId: string | null };
    expect(secondRun.interruptedRunId).toBe(firstRun.runId);

    const abortedOutcome = await running;
    expect(abortedOutcome.status).toBe("canceled");
    const partialWords = abortedOutcome.text.trim().split(/\s+/).filter(Boolean);
    expect(partialWords.length).toBeGreaterThan(0);
    expect(partialWords.length).toBeLessThan(words.length);

    const [abortedRun] = await db.select().from(run).where(eq(run.id, firstRun.runId));
    expect(abortedRun?.status).toBe("canceled");

    const partial = await db
      .select()
      .from(message)
      .where(and(eq(message.runId, firstRun.runId), eq(message.role, "assistant")));
    expect(partial[0]?.status).toBe("complete");
    const partialText = (partial[0]?.parts[0] as { text?: string } | undefined)?.text ?? "";
    expect(partialText.startsWith("word0")).toBe(true);

    const nextOutcome = await executeRun({
      db,
      gateway: slowGateway(["fresh", "answer"], 5),
      runId: secondRun.runId,
      abortPollMs: 20,
    });
    expect(nextOutcome.status).toBe("done");

    const [nextRun] = await db.select().from(run).where(eq(run.id, secondRun.runId));
    expect(nextRun?.status).toBe("done");
  }, 45_000);

  it("treats an external abort as a cancellation, not a finished answer", async () => {
    const sent = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "take your time" }),
    });
    const { runId } = (await sent.json()) as { runId: string };

    const controller = new AbortController();
    const words = Array.from({ length: 60 }, (_, index) => `slow${index}`);
    const running = executeRun({
      db,
      gateway: slowGateway(words, 40),
      runId,
      abortPollMs: 20,
      signal: controller.signal,
    });

    await sleep(150);
    controller.abort();

    const outcome = await running;
    expect(outcome.status).toBe("canceled");
    expect(outcome.text.trim().length).toBeGreaterThan(0);

    const [row] = await db.select().from(run).where(eq(run.id, runId));
    expect(row?.status).toBe("canceled");
  }, 30_000);

  it("resumes a redelivered run on the assistant message the first attempt left", async () => {
    const sent = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "answer even if I crash" }),
    });
    const { runId } = (await sent.json()) as { runId: string };

    // What a worker killed mid-stream leaves behind: a running run and a
    // streaming assistant message.
    const staleId = newId();
    await db.update(run).set({ status: "running" }).where(eq(run.id, runId));
    await db.insert(message).values({
      id: staleId,
      conversationId,
      runId,
      role: "assistant",
      parts: [{ type: "text", text: "half an ans" }],
      status: "streaming",
    });

    const outcome = await executeRun({
      db,
      gateway: slowGateway(["resumed"], 1),
      runId,
      abortPollMs: 20,
    });

    expect(outcome.status).toBe("done");
    expect(outcome.assistantMessageId).toBe(staleId);

    const rows = await db
      .select()
      .from(message)
      .where(and(eq(message.runId, runId), eq(message.role, "assistant")));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.parts[0] as { text?: string } | undefined)?.text).toBe("resumed ");
  }, 30_000);
});
