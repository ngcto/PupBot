import { loadEnv } from "@pupbot/config/load-env";
import { createApp } from "../src/app.ts";
import { executeRun } from "@pupbot/agent";
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
} from "@pupbot/db";
import type { ModelGateway } from "@pupbot/providers";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

loadEnv();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("conversation run protocol", () => {
  const app = createApp({ enqueue: async () => {} });
  const db = database();
  const email = `stream-${Date.now()}@pupbot.dev`;
  let cookie = "";
  let conversationId = "";
  let botId = "";

  beforeAll(async () => {
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
      name: "Test Pup",
      avatar: { shape: "pup", color: "amber" },
      accentColor: "#f69412",
      instructions: "Test bot.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Test" });
  }, 30_000);

  afterAll(async () => {
    await db.delete(user).where(eq(user.email, email));
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

    await sleep(180);

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
});
