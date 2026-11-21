import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { executeRun } from "@terabot/agent";
import {
  bot,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  message,
  newId,
  run,
  user,
} from "@terabot/db";
import type { ModelGateway } from "@terabot/providers";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What a gated run looks like from the thread's side.
 *
 * The point of this file: a refusal must arrive as the bot's own reply. A blank
 * thread, an error bubble, or a silently failed run would all be regressions
 * against the product rule "the bot tells the person what happened".
 */

const NOTICE = {
  code: "plan_required",
  situation: "No cloud plan is active on this account.",
  resolution: "The person can choose one in Settings → Billing.",
};

/** Fails the test if the model is called at all: a gated run must not spend. */
function forbiddenGateway(): ModelGateway {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("the model must not be called for a gated run");
    },
  };
}

describe("gated run", () => {
  let userId = "";
  let botId = "";
  let conversationId = "";

  beforeAll(async () => {
    const email = `gated-${randomUUID()}@terabot.dev`;
    const inserted = await database()
      .insert(user)
      .values({ id: `gated_${randomUUID()}`, email, name: "Gated" })
      .returning({ id: user.id });
    userId = inserted[0]!.id;
    await ensureWorkspace(userId, "Gated");

    const workspace = await database().select().from(user).where(eq(user.id, userId)).limit(1);
    expect(workspace[0]).toBeTruthy();


    const { findWorkspace } = await import("@terabot/db");
    const found = await findWorkspace(userId);
    expect(found).toBeTruthy();

    botId = newId();
    conversationId = newId();
    await database().insert(bot).values({
      id: botId,
      workspaceId: found!.id,
      name: "Gated Bot",
      avatar: { shape: "circle", color: "blue" },
      accentColor: "#1884fc",
      instructions: "",
    });
    await database().insert(conversation).values({
      id: conversationId,
      botId,
      title: "Gated Bot",
      isPrimary: true,
    });
    await database().insert(message).values({
      id: newId(),
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      status: "complete",
    });
  });

  afterAll(async () => {
    await database().delete(user).where(eq(user.id, userId));
    await closeDatabase();
  });

  it("answers with the notice instead of calling the model", async () => {
    const runId = newId();
    await database().insert(run).values({ id: runId, conversationId, botId, status: "queued" });

    const outcome = await executeRun({
      db: database(),
      gateway: forbiddenGateway(),
      runId,
      userId,
      gate: async () => ({ allowed: false, notice: NOTICE }),
    });

    expect(outcome.status).toBe("done");
    expect(outcome.gated).toBe("plan_required");
    expect(outcome.text).toContain("No cloud plan is active");
    expect(outcome.text).toContain("Settings → Billing");
  });

  it("writes that reply as a finished assistant message in the thread", async () => {
    const runId = newId();
    await database().insert(run).values({ id: runId, conversationId, botId, status: "queued" });

    const outcome = await executeRun({
      db: database(),
      gateway: forbiddenGateway(),
      runId,
      userId,
      gate: async () => ({ allowed: false, notice: NOTICE }),
    });

    const rows = await database()
      .select()
      .from(message)
      .where(eq(message.id, outcome.assistantMessageId!))
      .limit(1);
    const saved = rows[0]!;
    expect(saved.role).toBe("assistant");
    expect(saved.status).toBe("complete");
    expect(JSON.stringify(saved.parts)).toContain("Settings → Billing");
  });

  it("does not gate a run when access is allowed", async () => {
    const runId = newId();
    await database().insert(run).values({ id: runId, conversationId, botId, status: "queued" });

    // Allowed, but no endpoint is connected, so the run fails for that reason —
    // which proves it got past the gate rather than stopping at it.
    const outcome = await executeRun({
      db: database(),
      gateway: forbiddenGateway(),
      runId,
      userId,
      gate: async () => ({ allowed: true, notice: null }),
    });
    expect(outcome.gated).toBeUndefined();
    expect(outcome.error).toContain("No model endpoint");
  });

  it("does not consult the gate when no account is supplied", async () => {
    const runId = newId();
    await database().insert(run).values({ id: runId, conversationId, botId, status: "queued" });
    let called = false;
    const outcome = await executeRun({
      db: database(),
      gateway: forbiddenGateway(),
      runId,
      gate: async () => {
        called = true;
        return { allowed: false, notice: NOTICE };
      },
    });
    expect(called).toBe(false);
    expect(outcome.gated).toBeUndefined();
  });
});
