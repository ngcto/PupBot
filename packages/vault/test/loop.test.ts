import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { executeRun } from "@terabot/agent";
import type { RunTool } from "@terabot/agent";
import {
  auth,
  bot,
  workspace,
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
import type { ModelGateway, ModelEvent, StreamRequest } from "@terabot/providers";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultService } from "../src/service.ts";
import type { VaultFillSink } from "../src/fill.ts";
import { vaultTools } from "../src/tools-run.ts";

/**
 * The structural claim, tested through the real harness rather than around it: a
 * stored password drives a fill and **never appears in the request the model is
 * sent**. The gateway below records every message it is handed, so the assertion is
 * about what actually left the process, not about what a helper returned.
 */

interface RecordedTurn {
  messages: StreamRequest["messages"];
  tools: string[];
}

/**
 * A gateway that asks for a tool on its first turn and answers on its second, so
 * the loop has something to iterate. It records what it was sent each time.
 */
function scriptedGateway(turns: RecordedTurn[], script: (turn: number) => ModelEvent[]): ModelGateway {
  let call = 0;
  return {
    async *stream(request) {
      turns.push({
        messages: structuredClone(request.messages),
        tools: (request.tools ?? []).map((tool) => tool.name),
      });
      const events = script(call);
      call += 1;
      for (const event of events) yield event;
    },
  };
}

const SECRET = "fake-hunter2-not-a-real-password";

describe("the tool loop", () => {
  let db: Database;
  let vault: VaultService;
  let workspaceId: string;
  let botId: string;
  let conversationId: string;
  let endpointId: string;
  const email = `vault-loop-${Date.now()}@terabot.test`;

  beforeAll(async () => {
    db = database();
    vault = new VaultService(db);

    const signUp = await auth().api.signUpEmail({
      body: { email, password: "vault-loop-password", name: "Vault Loop" },
      returnHeaders: true,
    });
    const created = signUp.response.user;
    const space = await ensureWorkspace(created.id, "Vault Loop");
    workspaceId = space.id;

    endpointId = newId();
    await db.insert(modelEndpoint).values({
      id: endpointId,
      workspaceId,
      kind: "openai-chat",
      label: "loop test",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "test-model",
      catalogMatch: "unmatched",
    });

    botId = newId();
    conversationId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId,
      name: "Vault Tera",
      avatar: { shape: "mug", color: "amber" },
      accentColor: "#f69412",
      instructions: "Test bot.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Vault loop" });
  }, 30_000);

  afterAll(async () => {
    if (db) await db.delete(user).where(eq(user.email, email));
    await closeDatabase();
  });

  async function seedRun(text: string): Promise<string> {
    await db.insert(message).values({
      id: newId(),
      conversationId,
      role: "user",
      parts: [{ type: "text", text }],
      status: "complete",
    });
    const runId = newId();
    await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });
    return runId;
  }

  it("runs a tool call, replays it to the model, and keeps the secret out of every request", async () => {
    const item = await vault.create({
      workspaceId,
      userId: await ownerIdOf(db, workspaceId),
      kind: "login",
      label: "Loop GitHub",
      domain: "github.com",
      values: { username: "octocat", password: SECRET },
    });

    const typed: Array<{ field: string; value: string }> = [];
    const sink: VaultFillSink = {
      fill: async ({ field, value }) => {
        typed.push({ field, value });
        return { effect: "confirmed", verified: true };
      },
    };

    const runId = await seedRun("sign in to github and tell me what you see");
    const turns: RecordedTurn[] = [];
    const gateway = scriptedGateway(turns, (turn) =>
      turn === 0
        ? [
            { type: "text_delta", text: "Signing in." },
            {
              type: "tool_call_start",
              id: "call_1",
              name: "vault_fill",
            },
            {
              type: "tool_call_end",
              id: "call_1",
              arguments: JSON.stringify({
                itemId: item.id,
                field: "password",
                token: "snap_1:4",
                snapshotId: "snap_1",
                url: "https://github.com/session",
              }),
            },
            { type: "usage", inputTokens: 20, outputTokens: 5 },
          ]
        : [{ type: "text_delta", text: "Done — you are signed in." }, { type: "usage", inputTokens: 30, outputTokens: 8 }],
    );

    const tools = vaultTools({ db, vault, sink });
    const outcome = await executeRun({ db, gateway, runId, tools, abortPollMs: 20 });

    expect(outcome.status).toBe("done");
    expect(typed).toEqual([{ field: "password", value: SECRET }]);
    expect(outcome.text).toContain("Done — you are signed in.");

    // Two model turns: the one that asked, and the one that answered.
    expect(turns).toHaveLength(2);
    expect(turns[0]!.tools).toContain("vault_fill");

    // The second turn is the replay: the assistant's call and the tool's result.
    const replay = turns[1]!.messages;
    const assistantCall = replay.find((entry) => entry.role === "assistant" && entry.toolCalls?.length);
    expect(assistantCall?.toolCalls?.[0]?.name).toBe("vault_fill");
    const toolResult = replay.find((entry) => entry.role === "tool");
    expect(toolResult?.content).toContain("read it back");

    // The whole request, serialised, holds no password — that is the guarantee.
    const everything = JSON.stringify(turns);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("v1:");

    // Nor does the transcript the UI reads, nor the run's tool-call record.
    const events = await db
      .select()
      .from(runEvent)
      .where(eq(runEvent.runId, runId))
      .orderBy(asc(runEvent.seq));
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
  }, 30_000);

  it("turns a refused fill into a tool result the model can act on", async () => {
    const item = await vault.create({
      workspaceId,
      userId: await ownerIdOf(db, workspaceId),
      kind: "login",
      label: "Wrong site",
      domain: "github.com",
      values: { username: "octocat", password: SECRET },
    });

    const typed: string[] = [];
    const sink: VaultFillSink = {
      fill: async ({ value }) => {
        typed.push(value);
        return { effect: "confirmed" as const, verified: true };
      },
    };

    const runId = await seedRun("fill this");
    const turns: RecordedTurn[] = [];
    const gateway = scriptedGateway(turns, (turn) =>
      turn === 0
        ? [
            { type: "tool_call_start", id: "c1", name: "vault_fill" },
            {
              type: "tool_call_end",
              id: "c1",
              arguments: JSON.stringify({
                itemId: item.id,
                field: "password",
                token: "snap_9:2",
                snapshotId: "snap_9",
                url: "https://github.com.evil.test/login",
              }),
            },
          ]
        : [{ type: "text_delta", text: "I could not sign in there." }],
    );

    const outcome = await executeRun({ db, gateway, runId, tools: vaultTools({ db, vault, sink }), abortPollMs: 20 });
    expect(outcome.status).toBe("done");

    // Nothing was typed, and the model was told why in words it can use.
    expect(typed).toEqual([]);
    const toolResult = turns[1]!.messages.find((entry) => entry.role === "tool");
    expect(toolResult?.content).toContain("saved for github.com");
    expect(toolResult?.content).toContain("github.com.evil.test");
    expect(JSON.stringify(turns)).not.toContain(SECRET);
  }, 30_000);

  it("survives a tool that throws, instead of failing the whole message", async () => {
    const runId = await seedRun("boom");
    const exploding: RunTool = {
      schema: { name: "explode", description: "Always fails.", parameters: { type: "object", properties: {} } },
      handler: async () => {
        throw new Error("the driver went away");
      },
    };

    const turns: RecordedTurn[] = [];
    const gateway = scriptedGateway(turns, (turn) =>
      turn === 0
        ? [
            { type: "tool_call_start", id: "c1", name: "explode" },
            { type: "tool_call_end", id: "c1", arguments: "{}" },
          ]
        : [{ type: "text_delta", text: "That tool is broken; here is what I can say without it." }],
    );

    const outcome = await executeRun({ db, gateway, runId, tools: [exploding], abortPollMs: 20 });
    expect(outcome.status).toBe("done");
    expect(outcome.text).toContain("here is what I can say");

    const toolResult = turns[1]!.messages.find((entry) => entry.role === "tool");
    expect(toolResult?.content).toBe("the driver went away");
  }, 30_000);

  it("caps a model that keeps calling tools", async () => {
    const runId = await seedRun("loop forever");
    const noop: RunTool = {
      schema: { name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} } },
      handler: async () => ({ result: "nothing happened" }),
    };

    let turn = 0;
    const gateway: ModelGateway = {
      async *stream() {
        const id = `c${turn++}`;
        yield { type: "tool_call_start" as const, id, name: "noop" };
        yield { type: "tool_call_end" as const, id, arguments: "{}" };
      },
    };

    const outcome = await executeRun({ db, gateway, runId, tools: [noop], abortPollMs: 20 });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/tool steps/);
    // A bounded loop: the cap plus at most one more turn started before the check.
    expect(turn).toBeLessThanOrEqual(10);
  }, 30_000);

  it("leaves the plain chat path untouched when a run has no tools", async () => {
    const runId = await seedRun("hello with no tools");
    const turns: RecordedTurn[] = [];
    const gateway = scriptedGateway(turns, () => [{ type: "text_delta", text: "Just talking." }]);

    const outcome = await executeRun({ db, gateway, runId, abortPollMs: 20 });
    expect(outcome.status).toBe("done");
    expect(outcome.text).toBe("Just talking.");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.tools).toEqual([]);
  }, 30_000);
});

/** The workspace's owner, which is the person a vault item belongs to. */
async function ownerIdOf(db: Database, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ ownerId: workspace.ownerId })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return row?.ownerId ?? "";
}
