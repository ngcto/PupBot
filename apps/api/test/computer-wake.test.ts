import { loadEnv } from "@terabot/config/load-env";
import { executeRun } from "@terabot/agent";
import type { RunComputer } from "@terabot/agent";
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
} from "@terabot/db";
import type { ModelGateway } from "@terabot/providers";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

loadEnv();

const db = database();

async function fixture(name: string) {
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@terabot.dev`;
  const signUp = await auth().api.signUpEmail({
    body: { email, password: "wake-test-password", name: "Wake Test" },
    returnHeaders: true,
  });
  const created = signUp.response.user as { id: string };
  const space = await ensureWorkspace(created.id, "Wake Test");

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

  const botId = newId();
  const conversationId = newId();
  await db.insert(bot).values({
    id: botId,
    workspaceId: space.id,
    name: "Wake Tera",
    avatar: { shape: "tera", color: "amber" },
    accentColor: "#f69412",
    instructions: "Test bot.",
    modelEndpointId: endpointId,
    modelId: "test-model",
    computerState: "ready",
  });
  await db.insert(conversation).values({ id: conversationId, botId, title: "Wake" });

  const messageId = newId();
  await db.insert(message).values({
    id: messageId,
    conversationId,
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  });

  const runId = newId();
  await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });

  return { botId, conversationId, runId, user: created as { id: string; name: string; email: string } };
}

afterAll(async () => {
  await closeDatabase();
});

describe("the run path wakes the bot's computer before the first token", () => {
  it("calls ensureReady before the model and reports Waking your computer", async () => {
    const { runId } = await fixture("wake-order");
    const order: string[] = [];

    const computer: RunComputer = {
      async ensureReady() {
        order.push("wake");
        return { ok: true, leaseId: "lease-1", woke: true };
      },
      async release(_botId, leaseId) {
        order.push(`release:${leaseId}`);
      },
    };
    const gateway: ModelGateway = {
      async *stream() {
        order.push("model");
        yield { type: "text_delta" as const, text: "woof" };
      },
    };

    const outcome = await executeRun({ db, gateway, runId, computer });

    expect(outcome.status).toBe("done");
    expect(order).toEqual(["wake", "model", "release:lease-1"]);

    const events = await db.select().from(runEvent).where(eq(runEvent.runId, runId)).orderBy(asc(runEvent.seq));
    const steps = events.filter((event) => event.type === "step");
    expect(steps[0]?.payload).toMatchObject({ label: "Waking your computer" });
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
  });

  it("ends the run with the reason and never calls the model when the computer is unavailable", async () => {
    const { runId } = await fixture("wake-blocked");
    let modelCalled = false;

    const computer: RunComputer = {
      async ensureReady() {
        return { ok: false, reason: "Every computer account is full right now.", blocked: true };
      },
      async release() {},
    };
    const gateway: ModelGateway = {
      async *stream() {
        modelCalled = true;
        yield { type: "text_delta" as const, text: "should not happen" };
      },
    };

    const outcome = await executeRun({ db, gateway, runId, computer });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("Every computer account is full");
    expect(modelCalled).toBe(false);
    const rows = await db.select().from(run).where(eq(run.id, runId));
    expect(rows[0]?.status).toBe("error");
  });

  it("still runs when no computer hook is supplied", async () => {
    const { runId } = await fixture("wake-none");
    const gateway: ModelGateway = {
      async *stream() {
        yield { type: "text_delta" as const, text: "plain" };
      },
    };
    const outcome = await executeRun({ db, gateway, runId });
    expect(outcome.status).toBe("done");
    const rows = await db.select().from(runEvent).where(eq(runEvent.runId, runId));
    expect(rows.some((event) => event.type === "step")).toBe(false);
  });
});
