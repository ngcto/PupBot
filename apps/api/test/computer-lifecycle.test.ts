import { loadEnv } from "@terabot/config/load-env";
import { executeRun } from "@terabot/agent";
import type { Machine, RunComputer } from "@terabot/agent";
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
} from "@terabot/db";
import type { ModelEvent, ModelGateway } from "@terabot/providers";
import { afterAll, describe, expect, it } from "vitest";

loadEnv();

const db = database();

async function fixture(name: string) {
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@terabot.dev`;
  const signUp = await auth().api.signUpEmail({
    body: { email, password: "lifecycle-test-password", name: "Lifecycle Test" },
    returnHeaders: true,
  });
  const created = signUp.response.user as { id: string };
  const space = await ensureWorkspace(created.id, "Lifecycle Test");

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
    name: "Life Tera",
    avatar: { shape: "mug", color: "amber" },
    accentColor: "#f69412",
    instructions: "Test bot.",
    modelEndpointId: endpointId,
    modelId: "test-model",
    // Deliberately unbound: nothing is provisioned until a tool asks for it.
    computerState: "unbound",
  });
  await db.insert(conversation).values({ id: conversationId, botId, title: "Lifecycle" });

  const messageId = newId();
  await db.insert(message).values({
    id: messageId,
    conversationId,
    role: "user",
    parts: [{ type: "text", text: "run something for me" }],
  });

  const runId = newId();
  await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });

  return { botId, conversationId, runId, user: created as { id: string; name: string; email: string } };
}

afterAll(async () => {
  await closeDatabase();
});

/** A gateway that replays a fixed script of rounds, one array of events per call. */
function scriptedGateway(rounds: ModelEvent[][]): ModelGateway {
  let call = 0;
  return {
    async *stream() {
      const events = rounds[call] ?? [{ type: "text_delta" as const, text: "done" }];
      call += 1;
      for (const event of events) yield event;
    },
  };
}

describe("a computer is provisioned on first use, not before", () => {
  it("never asks for a machine when the bot only chats", async () => {
    const { runId } = await fixture("chat-only");
    let leased = false;

    const computer: RunComputer = {
      async withLease(_botId, fn) {
        leased = true;
        return { ok: true, value: await fn({ computerId: "c1", exec: async () => emptyExec() }), computerId: "c1", woke: false };
      },
    };

    const outcome = await executeRun({
      db,
      gateway: scriptedGateway([[{ type: "text_delta", text: "just talking" }]]),
      runId,
      computer,
    });

    expect(outcome.status).toBe("done");
    expect(outcome.text).toBe("just talking");
    // The point of the whole change: a bot that only talks costs no box.
    expect(leased).toBe(false);
  });

  it("asks for a machine exactly when the model calls a tool, and runs the command", async () => {
    const { runId } = await fixture("tool-use");
    const order: string[] = [];
    const commands: string[] = [];

    const computer: RunComputer = {
      async withLease(_botId, fn) {
        order.push("lease");
        const machine: Machine = {
          computerId: "c1",
          async exec(command) {
            order.push("exec");
            commands.push(command);
            return { stdout: "hello from the box", stderr: "", exitCode: 0, timedOut: false, truncated: false };
          },
        };
        return { ok: true, value: await fn(machine), computerId: "c1", woke: true };
      },
    };

    const outcome = await executeRun({
      db,
      gateway: scriptedGateway([
        [
          { type: "tool_call_start", id: "call_1", name: "run_command" },
          { type: "tool_call_end", id: "call_1", arguments: '{"command":"echo hi"}' },
        ],
        [{ type: "text_delta", text: "it printed hello from the box" }],
      ]),
      runId,
      computer,
    });

    expect(outcome.status).toBe("done");
    expect(commands).toEqual(["echo hi"]);
    expect(order).toEqual(["lease", "exec"]);
    expect(outcome.text).toBe("it printed hello from the box");
  });
});

describe("a computer failure reaches the model as an obstacle it must explain", () => {
  it("hands the model the situation, the cause and the fix, and the bot says it", async () => {
    const { runId } = await fixture("blocked-no-plan");
    const toolResults: string[] = [];

    // No plan: the deployment supplies machines, this workspace has none.
    const computer: RunComputer = {
      async withLease() {
        return {
          ok: false,
          obstacle: {
            code: "no_plan",
            summary: "No computer is available because no cloud plan is active on this account.",
            detail: "Computers are provided by the deployment, but only for accounts with an active plan.",
            resolution: "The user can choose a plan in Settings, under Billing.",
            userAction: "plan",
            retryable: false,
          },
        };
      },
    };

    const gateway: ModelGateway = {
      async *stream(request) {
        const last = request.messages.at(-1);
        if (last?.role === "tool") toolResults.push(last.content);
        // Round one asks for the tool; round two answers, having read the result.
        if (!last || last.role !== "tool") {
          yield { type: "tool_call_start" as const, id: "call_1", name: "run_command" };
          yield { type: "tool_call_end" as const, id: "call_1", arguments: '{"command":"ls"}' };
          return;
        }
        yield {
          type: "text_delta" as const,
          text: "I could not run that: this account has no cloud plan, so I have no machine. Choose a plan in Settings, under Billing, and I can try again.",
        };
      },
    };

    const outcome = await executeRun({ db, gateway, runId, computer });

    // The error the model actually received: all three parts, in the tool result.
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toContain("no cloud plan is active");
    expect(toolResults[0]).toContain("Why:");
    expect(toolResults[0]).toContain("Settings, under Billing");
    expect(toolResults[0]).toContain("choose a plan");

    // The reply the bot produced: prose that relays it, not a pasted error.
    expect(outcome.status).toBe("done");
    expect(outcome.text).toContain("no cloud plan");
    expect(outcome.text).toContain("Settings, under Billing");
    expect(outcome.text).not.toContain("BLOCKED:");
  });

  it("still answers in prose when the model produces no text after being blocked", async () => {
    const { runId } = await fixture("blocked-silent-model");

    const computer: RunComputer = {
      async withLease() {
        return {
          ok: false,
          obstacle: {
            code: "all_busy",
            summary: "All computers are busy right now: every provider has used all of its machines.",
            detail: "Tried 2 provider accounts.",
            resolution: "Nothing to buy and nothing to configure; it clears as bots go idle.",
            userAction: "wait",
            retryable: true,
          },
        };
      },
    };

    // The model asks for the tool and then says nothing at all, twice.
    const gateway: ModelGateway = {
      async *stream(request) {
        const last = request.messages.at(-1);
        if (!last || last.role !== "tool") {
          yield { type: "tool_call_start" as const, id: "call_1", name: "run_command" };
          yield { type: "tool_call_end" as const, id: "call_1", arguments: '{"command":"ls"}' };
        }
      },
    };

    const outcome = await executeRun({ db, gateway, runId, computer });

    /*
     * The guarantee: a refusal never ends as an empty bubble. The model said
     * nothing, so the run answers on its own — what happened, what the user can
     * do, and whether waiting helps. It must not paste the raw "BLOCKED:".
     */
    expect(outcome.text.trim().length).toBeGreaterThan(0);
    expect(outcome.text).toContain("all of its machines");
    expect(outcome.text.toLowerCase()).toContain("again");
    expect(outcome.text).not.toContain("BLOCKED:");
  });
});

function emptyExec() {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
}
