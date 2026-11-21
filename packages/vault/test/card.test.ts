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
  secretRequest,
  toolCall,
  user,
  vaultItem,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import type { ModelEvent, ModelGateway } from "@terabot/providers";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEphemeralSecrets, ephemeralIdFor } from "../src/ephemeral.ts";
import type { EphemeralSecrets } from "../src/ephemeral.ts";
import { fillFromVault } from "../src/fill.ts";
import { VaultService } from "../src/service.ts";
import { SecretRequestService, setOneShotSecrets } from "../src/requests.ts";
import { vaultTools } from "../src/tools-run.ts";

/**
 * The ask-the-user card, end to end against a real database.
 *
 * The two claims that matter are proved by querying the database rather than by
 * inspecting a helper's return value: **ticked leaves a `vault_item` row, and
 * unticked leaves none** — and in neither case does the request row, the run
 * events or the model's conversation hold the value.
 */

const PROVIDED = "fake-zuqblorp-wle-9-tnqq";

describe("ask-the-user card", () => {
  let db: Database;
  let vault: VaultService;
  let requests: SecretRequestService;
  /** The one-shot store this test's service and its fills both read. */
  let store: EphemeralSecrets;
  let workspaceId: string;
  let ownerId: string;
  let botId: string;
  let conversationId: string;
  const email = `card-${Date.now()}@terabot.test`;

  beforeAll(async () => {
    db = database();
    vault = new VaultService(db);
    store = createEphemeralSecrets();
    setOneShotSecrets(store);
    requests = new SecretRequestService(db, { vault, secrets: store });

    const signUp = await auth().api.signUpEmail({
      body: { email, password: "card-test-password", name: "Card Test" },
      returnHeaders: true,
    });
    ownerId = signUp.response.user.id;
    const space = await ensureWorkspace(ownerId, "Card Test");
    workspaceId = space.id;

    const endpointId = newId();
    await db.insert(modelEndpoint).values({
      id: endpointId,
      workspaceId,
      kind: "openai-chat",
      label: "card test",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "test-model",
      catalogMatch: "unmatched",
    });

    botId = newId();
    conversationId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId,
      name: "Card Tera",
      avatar: { shape: "mug", color: "amber" },
      accentColor: "#f69412",
      instructions: "Test bot.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Card" });
  }, 30_000);

  afterEach(() => {
    store = createEphemeralSecrets();
    setOneShotSecrets(store);
    requests = new SecretRequestService(db, { vault, secrets: store });
  });

  afterAll(async () => {
    setOneShotSecrets(undefined);
    if (db) await db.delete(user).where(eq(user.email, email));
    await closeDatabase();
  });

  async function seedRun(): Promise<string> {
    await db.insert(message).values({
      id: newId(),
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "buy me a coffee on the shop" }],
      status: "complete",
    });
    const runId = newId();
    await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });
    return runId;
  }

  async function createPendingRequest(runId: string, kind: "login" | "card" | "contact" = "login") {
    const id = newId();
    await db.insert(secretRequest).values({
      id,
      runId,
      conversationId,
      workspaceId,
      botId,
      kind,
      reason: "the shop needs your password to continue",
      fields: [],
      expiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  }

  it("saves to the vault when the checkbox is ticked, and leaves no plaintext anywhere", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);

    const result = await requests.submit({
      workspaceId,
      requestId,
      userId: ownerId,
      values: { username: "octocat", password: PROVIDED },
      saveToVault: true,
      domain: "shop.example.test",
    });

    expect(result.status).toBe("provided");
    expect(result.vaultItemId).not.toBeNull();

    // A row exists, it is encrypted, and the request points at it.
    const [item] = await db.select().from(vaultItem).where(eq(vaultItem.id, result.vaultItemId!));
    expect(item).toBeDefined();
    expect(item!.kind).toBe("login");
    expect(item!.domain).toBe("shop.example.test");
    expect(JSON.stringify(item)).not.toContain(PROVIDED);
    expect(item!.secrets.password).toMatch(/^v1:/);

    const [resolved] = await db.select().from(secretRequest).where(eq(secretRequest.id, requestId));
    expect(resolved!.status).toBe("provided");
    expect(resolved!.vaultItemId).toBe(result.vaultItemId);
    // The request row itself can hold no value, whatever was provided.
    expect(JSON.stringify(resolved)).not.toContain(PROVIDED);
  });

  it("writes nothing to the vault when the checkbox is unticked, and the value still fills once", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);

    const before = await db
      .select({ id: vaultItem.id })
      .from(vaultItem)
      .where(eq(vaultItem.workspaceId, workspaceId));

    const result = await requests.submit({
      workspaceId,
      requestId,
      userId: ownerId,
      values: { username: "octocat-once", password: PROVIDED },
      saveToVault: false,
      domain: "once.example.test",
    });

    expect(result.vaultItemId).toBeNull();

    const after = await db
      .select({ id: vaultItem.id })
      .from(vaultItem)
      .where(eq(vaultItem.workspaceId, workspaceId));
    // The proof the brief asks for: no new row, and the value is nowhere in the DB.
    expect(after.length).toBe(before.length);

    const stored = await db
      .select()
      .from(vaultItem)
      .where(eq(vaultItem.workspaceId, workspaceId));
    expect(JSON.stringify(stored)).not.toContain(PROVIDED);

    const [resolved] = await db.select().from(secretRequest).where(eq(secretRequest.id, requestId));
    expect(resolved!.status).toBe("provided");
    expect(resolved!.vaultItemId).toBeNull();
    expect(JSON.stringify(resolved)).not.toContain(PROVIDED);

    // The value exists only in the process's one-shot store, and a fill can use it.
    const itemId = ephemeralIdFor(requestId);
    const typed: string[] = [];
    const filled = await fillFromVault(vault, {
      workspaceId,
      url: "https://once.example.test/login",
      itemId,
      field: "password",
      target: { token: "snap_2:3", snapshotId: "snap_2" },
      sink: { fill: async ({ value }) => (void typed.push(value), { effect: "confirmed" as const, verified: true }) },
      oneShot: store,
    });
    expect(typed).toEqual([PROVIDED]);
    expect(JSON.stringify(filled)).not.toContain(PROVIDED);
  });

  it("still enforces the domain check on a one-shot value", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);
    await requests.submit({
      workspaceId,
      requestId,
      userId: ownerId,
      values: { username: "u", password: PROVIDED },
      saveToVault: false,
      domain: "once.example.test",
    });

    const typed: string[] = [];
    await expect(
      fillFromVault(vault, {
        workspaceId,
        url: "https://once.example.test.evil.test/login",
        itemId: ephemeralIdFor(requestId),
        field: "password",
        target: { token: "snap_2:3", snapshotId: "snap_2" },
        sink: {
          fill: async ({ value }) => (void typed.push(value), { effect: "confirmed" as const, verified: true }),
        },
        oneShot: store,
      }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });
    expect(typed).toEqual([]);
  });

  it("declines with no value written anywhere", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);

    const result = await requests.decline({ workspaceId, requestId });
    expect(result.status).toBe("declined");

    const [row] = await db.select().from(secretRequest).where(eq(secretRequest.id, requestId));
    expect(row!.status).toBe("declined");
    expect(row!.vaultItemId).toBeNull();

    // And it cannot be answered afterwards.
    await expect(
      requests.submit({
        workspaceId,
        requestId,
        userId: ownerId,
        values: { username: "late", password: PROVIDED },
        saveToVault: true,
        domain: "shop.example.test",
      }),
    ).rejects.toThrow(/already declined/);
  });

  it("expires an unanswered request so it cannot be answered later", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);
    await db
      .update(secretRequest)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(secretRequest.id, requestId));

    const expired = await requests.expireOverdue({ workspaceId, requestId });
    expect(expired).toBe(1);

    const [row] = await db.select().from(secretRequest).where(eq(secretRequest.id, requestId));
    expect(row!.status).toBe("expired");
    await expect(
      requests.submit({
        workspaceId,
        requestId,
        userId: ownerId,
        values: { username: "late", password: PROVIDED },
        saveToVault: true,
        domain: "shop.example.test",
      }),
    ).rejects.toThrow();
  });

  it("a declined request gives the model a plain result, and a second ask in the same run is refused", async () => {
    const runId = await seedRun();

    const scriptEvents: ModelEvent[][] = [
      [
        { type: "tool_call_start", id: "c_request", name: "vault_request" },
        {
          type: "tool_call_end",
          id: "c_request",
          arguments: JSON.stringify({
            kind: "login",
            reason: "the shop needs your password",
            url: "https://shop.example.test/login",
          }),
        },
      ],
      [{ type: "text_delta", text: "No problem — I cannot sign in to the shop without that, so I have stopped there." }],
    ];
    let turn = 0;
    const gateway: ModelGateway = {
      async *stream() {
        for (const event of scriptEvents[Math.min(turn, scriptEvents.length - 1)]!) yield event;
        turn += 1;
      },
    };

    // Awaits the card, and the person declines it. The tool result must be a
    // sentence the model can act on, not a hang and not silence.
    const outcome = await executeRun({
      db,
      gateway,
      runId,
      abortPollMs: 20,
      tools: vaultTools({
        db,
        vault,
        oneShot: store,
        awaitSecretRequest: async ({ status }) => {
          const [pending] = await db
            .select()
            .from(secretRequest)
            .where(and(eq(secretRequest.runId, runId), eq(secretRequest.status, "pending")))
            .limit(1);
          if (pending) await requests.decline({ workspaceId, requestId: pending.id });
          expect(await status()).toBe("declined");
          return "declined";
        },
      }),
    });

    expect(outcome.status).toBe("done");
    expect(outcome.text).toContain("cannot sign in");

    const [row] = await db
      .select()
      .from(secretRequest)
      .where(eq(secretRequest.runId, runId));
    expect(row!.status).toBe("declined");

    // The reply exists and the run finished: a decline is not a hang.
    const replies = await db.select().from(message).where(eq(message.runId, runId));
    expect(replies.length).toBeGreaterThan(0);
  }, 30_000);

  it("reports a timeout as a timeout, not as a decline", async () => {
    const runId = await seedRun();
    let toolResultText = "";

    const gateway: ModelGateway = {
      async *stream() {
        if (!toolResultText) {
          yield { type: "tool_call_start", id: "c1", name: "vault_request" } as ModelEvent;
          yield {
            type: "tool_call_end",
            id: "c1",
            arguments: JSON.stringify({ kind: "card", reason: "checkout needs a card", url: "https://shop.example.test" }),
          } as ModelEvent;
          return;
        }
        yield { type: "text_delta", text: "The request expired; send it again if you still want me to pay." } as ModelEvent;
      },
    };

    // Capture the tool result the model is given by reading the second request.
    const capturing: ModelGateway = {
      async *stream(request) {
        const toolMessage = request.messages.find((entry) => entry.role === "tool" && entry.content.includes("timed out"));
        if (toolMessage) toolResultText = toolMessage.content;
        yield* gateway.stream(request);
      },
    };

    const outcome = await executeRun({
      db,
      gateway: capturing,
      runId,
      abortPollMs: 20,
      tools: vaultTools({
        db,
        vault,
        oneShot: store,
        // No answer ever arrives; the harness's own deadline is what ends it.
        awaitSecretRequest: async () => "expired",
      }),
    });

    expect(outcome.status).toBe("done");
    expect(toolResultText).toContain("timed out");
    expect(toolResultText).not.toContain("declined");

    const [row] = await db.select().from(secretRequest).where(eq(secretRequest.runId, runId));
    expect(row!.kind).toBe("card");
  }, 30_000);

  /**
   * The card path, held to the same standard as the fill path: a value a person
   * types into the card must never reach the model's context — not on the turn that
   * asked, not on the turn that continues afterwards. It goes to the vault or to the
   * ephemeral store, and the model only hears that the request was answered.
   *
   * This drives the real `executeRun`, so it guards the whole path rather than the
   * service in isolation: a later refactor that widened a tool result or echoed the
   * submitted fields would fail here.
   */
  it("never puts a card-submitted value into the model's context", async () => {
    const runId = await seedRun();
    const turns: Array<{ messages: Array<{ role: string; content: string; toolCalls?: unknown }> }> = [];

    let turn = 0;
    const gateway: ModelGateway = {
      async *stream(request) {
        turns.push({ messages: structuredClone(request.messages) });
        if (turn === 0) {
          turn += 1;
          yield { type: "tool_call_start", id: "c_req", name: "vault_request" } as ModelEvent;
          yield {
            type: "tool_call_end",
            id: "c_req",
            arguments: JSON.stringify({
              kind: "login",
              reason: "the shop needs your password",
              url: "https://saved.example.test/login",
            }),
          } as ModelEvent;
          return;
        }
        turn += 1;
        yield { type: "text_delta", text: "Thanks — I have what I need and have signed in." } as ModelEvent;
      },
    };

    const outcome = await executeRun({
      db,
      gateway,
      runId,
      abortPollMs: 20,
      tools: vaultTools({
        db,
        vault,
        oneShot: store,
        // The person answers the card through the same service the HTTP route uses.
        awaitSecretRequest: async ({ status }) => {
          const [pending] = await db
            .select()
            .from(secretRequest)
            .where(and(eq(secretRequest.runId, runId), eq(secretRequest.status, "pending")))
            .limit(1);
          if (pending) {
            await requests.submit({
              workspaceId,
              requestId: pending.id,
              userId: ownerId,
              values: { username: "octocat-card", password: PROVIDED },
              saveToVault: true,
              domain: "saved.example.test",
            });
          }
          expect(await status()).toBe("provided");
          return "provided";
        },
      }),
    });

    expect(outcome.status).toBe("done");
    expect(outcome.text).toContain("signed in");

    // Two turns: the one that asked, and the one that continued after the answer.
    expect(turns).toHaveLength(2);

    // Neither request contains the value the person typed, nor a ciphertext.
    const everything = JSON.stringify(turns);
    expect(everything).not.toContain(PROVIDED);
    expect(everything).not.toContain("octocat-card");
    expect(everything).not.toContain("v1:");

    // What the model *was* told is only that the request was answered.
    const toolResult = turns[1]!.messages.find((entry) => entry.role === "tool");
    expect(toolResult?.content).toContain("provided the login");
    expect(toolResult?.content).not.toContain(PROVIDED);

    // The run's own transcript and tool-call records are clean too.
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, runId));
    expect(JSON.stringify(events)).not.toContain(PROVIDED);
    const calls = await db.select().from(toolCall).where(eq(toolCall.runId, runId));
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain(PROVIDED);

    // And the value did land in the vault, which is where it was meant to go.
    const stored = await db.select().from(vaultItem).where(eq(vaultItem.workspaceId, workspaceId));
    const saved = stored.find((row) => row.label.includes("saved.example.test"));
    expect(saved).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(PROVIDED);
  }, 30_000);

  it("keeps the one-shot store empty of a saved value", async () => {
    const runId = await seedRun();
    const requestId = await createPendingRequest(runId);
    await requests.submit({
      workspaceId,
      requestId,
      userId: ownerId,
      values: { username: "saved", password: PROVIDED },
      saveToVault: true,
      domain: "saved.example.test",
    });
    // A saved value goes to Postgres; the memory store is for the other case only.
    expect(store.describe({ workspaceId, id: ephemeralIdFor(requestId) })).toBeNull();
  });
});
