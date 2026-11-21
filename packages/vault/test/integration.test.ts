import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { executeRun } from "@terabot/agent";
import type { RunTool } from "@terabot/agent";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEphemeralSecrets } from "../src/ephemeral.ts";
import { setOneShotSecrets } from "../src/requests.ts";
import { VaultService } from "../src/service.ts";
import { SecretRequestService } from "../src/requests.ts";
import type { VaultFillOutcome, VaultFillSink } from "../src/fill.ts";
import { vaultTools } from "../src/tools-run.ts";

/**
 * The NGS-80 acceptance proof, as one run.
 *
 * This is the criterion the Captain set for closing the issue, written as the run
 * it will be: **a vault item created through the card, a bot that signs in to a
 * local test form with it, and a query proving the value reached neither `run_event`
 * nor the request the model was sent.** It is skipped unless `VAULT_LIVE=1`, in the
 * same style as `outbound.test.ts`'s live case, and the skip is on the precondition
 * (a real driver as the sink), never on the claim.
 *
 * Run it with:
 *
 *   VAULT_LIVE=1 pnpm --filter @terabot/vault test test/integration.test.ts
 *
 * Why a skipped test rather than a script: the assertion is the deliverable. A
 * script somebody runs and reads leaves nothing failing when the guarantee rots.
 *
 * **What is real here and what is still a seam.** The form is a real HTTP server on
 * localhost, so the domain check the vault enforces in code actually runs against it
 * and the fill is aimed at a real origin. The sink is not a driver yet: `packages/cua`
 * is not on `main`, so the object below records what it was handed and reports
 * `confirmed`. That means this file proves the vault's half end to end today —
 * card → row → decrypt → sink, with the value absent from every model-facing
 * surface — and becomes a proof of the typing half the moment the driver replaces
 * the sink. Leaving it in the tree skipped is deliberate: it is the checklist, and
 * it fails loudly if any of the three steps regresses.
 */

const SECRET = "fake-vault-live-2fq7-not-a-real-password";
const USERNAME = "fake-octocat-live";

describe("NGS-80: a card, a login, and a value that never reaches the model", () => {
  let db: Database;
  let vault: VaultService;
  let requests: SecretRequestService;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let workspaceId: string;
  let ownerId: string;
  let botId: string;
  let conversationId: string;
  const email = `vault-live-${Date.now()}@terabot.test`;

  beforeAll(async () => {
    // A real origin, because `hostOf` reads the URL's hostname and a `data:` URL has
    // none — the domain check would (correctly) refuse it and prove nothing.
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<form><label>User <input name=user></label>" +
          "<label>Password <input name=password type=password></label></form>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;

    db = database();
    vault = new VaultService(db);
    setOneShotSecrets(createEphemeralSecrets());
    requests = new SecretRequestService(db, { vault });

    const signUp = await auth().api.signUpEmail({
      body: { email, password: "vault-live-password", name: "Vault Live" },
      returnHeaders: true,
    });
    ownerId = signUp.response.user.id;
    workspaceId = (await ensureWorkspace(ownerId, "Vault Live")).id;

    const endpointId = newId();
    await db.insert(modelEndpoint).values({
      id: endpointId,
      workspaceId,
      kind: "openai-chat",
      label: "vault live",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "test-model",
      catalogMatch: "unmatched",
    });

    botId = newId();
    conversationId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId,
      name: "Live Tera",
      avatar: { shape: "circle", color: "teal" },
      accentColor: "#0ea5a4",
      instructions: "Sign in to the test form.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Vault live" });
  }, 30_000);

  afterAll(async () => {
    setOneShotSecrets(undefined);
    if (db) await db.delete(user).where(eq(user.email, email));
    await closeDatabase();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(process.env.VAULT_LIVE !== "1")(
    "creates the item through the card, fills the form, and leaves no value in run_event or the model request",
    async () => {
      const host = new URL(baseUrl).hostname;
      const filled: Array<{ field: string; length: number }> = [];
      /** Stands in for the driver; see the file comment for why it is still this. */
      const sink: VaultFillSink = {
        async fill(input): Promise<VaultFillOutcome> {
          filled.push({ field: input.field, length: input.value.length });
          return {
            effect: "confirmed",
            verified: true,
            evidence: `${input.field} now shows ${input.value.length} characters`,
          };
        },
      };

      await db.insert(message).values({
        id: newId(),
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "sign in to the test shop" }],
        status: "complete",
      });
      const runId = newId();
      await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });

      /** Every request the model was handed, so the last assertion is about what left. */
      const turns: Array<{ messages: unknown }> = [];
      /**
       * The item id is only known after the card is answered, and the fill call
       * happens on the turn after that, so it is read through a getter rather than
       * captured — a stale empty string here would make the fill silently refuse and
       * the test pass for the wrong reason.
       */
      let savedItemId = "";

      let turn = 0;
      const gateway: ModelGateway = {
        async *stream(request) {
          turns.push({ messages: structuredClone(request.messages) });
          if (turn === 0) {
            turn += 1;
            yield { type: "tool_call_start", id: "c_ask", name: "vault_request" } as ModelEvent;
            yield {
              type: "tool_call_end",
              id: "c_ask",
              arguments: JSON.stringify({
                kind: "login",
                reason: "the shop needs a password",
                url: baseUrl,
              }),
            } as ModelEvent;
            return;
          }
          if (turn === 1) {
            turn += 1;
            yield { type: "tool_call_start", id: "c_fill", name: "vault_fill" } as ModelEvent;
            yield {
              type: "tool_call_end",
              id: "c_fill",
              // The model names an item and a field. It never sees the value.
              arguments: JSON.stringify({
                url: baseUrl,
                itemId: savedItemId,
                field: "password",
                token: "snap-live:7",
                snapshotId: "snap-live",
              }),
            } as ModelEvent;
            return;
          }
          yield { type: "text_delta", text: "Signed in." } as ModelEvent;
        },
      };

      const tools: RunTool[] = vaultTools({
        db,
        vault,
        sink,
        awaitSecretRequest: async ({ status }) => {
          const [pending] = await db
            .select()
            .from(secretRequest)
            .where(and(eq(secretRequest.runId, runId), eq(secretRequest.status, "pending")))
            .limit(1);
          // Step 1: the person answers the card and leaves Save to vault ticked.
          expect(pending).toBeDefined();
          await requests.submit({
            workspaceId,
            requestId: pending!.id,
            userId: ownerId,
            values: { username: USERNAME, password: SECRET },
            saveToVault: true,
            domain: host,
          });
          expect(await status()).toBe("provided");

          const [saved] = await db
            .select()
            .from(vaultItem)
            .where(eq(vaultItem.workspaceId, workspaceId))
            .limit(1);
          expect(saved).toBeDefined();
          savedItemId = saved!.id;
          return "provided";
        },
      });

      const outcome = await executeRun({ db, gateway, runId, abortPollMs: 20, tools });
      expect(outcome.status).toBe("done");

      // Step 1: ticking Save to vault left a row, and that row holds ciphertext.
      const stored = await db.select().from(vaultItem).where(eq(vaultItem.workspaceId, workspaceId));
      expect(stored.length).toBeGreaterThan(0);
      expect(JSON.stringify(stored)).not.toContain(SECRET);

      // Step 2: the value reached the sink, which is the only place a secret is
      // allowed to leave server memory, and the fill actually ran rather than
      // refusing because the item id was not ready.
      expect(filled).toContainEqual({ field: "password", length: SECRET.length });

      // Step 3, the query the issue asks for: not in the run's events, not in the
      // tool-call rows, not in any request the model was sent — and no ciphertext
      // either, which would leak format and length.
      const events = await db.select().from(runEvent).where(eq(runEvent.runId, runId));
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      const calls = await db.select().from(toolCall).where(eq(toolCall.runId, runId));
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain(SECRET);
      expect(JSON.stringify(turns)).not.toContain(SECRET);
      expect(JSON.stringify(turns)).not.toContain(USERNAME);
      expect(JSON.stringify(turns)).not.toContain("v1:");
      expect(JSON.stringify(events)).not.toContain("v1:");
    },
    60_000,
  );
});
