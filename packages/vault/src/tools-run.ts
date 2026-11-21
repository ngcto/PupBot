import { newId, secretRequest, type Database } from "@terabot/db";
import type { RunTool, ToolContext, ToolOutcome } from "@terabot/agent";
import { stringArg } from "@terabot/agent";
import { and, eq } from "drizzle-orm";
import { describeVaultError, VaultError } from "./errors.ts";
import { fillFromVault } from "./fill.ts";
import type { VaultFillSink } from "./fill.ts";
import { isVaultKind } from "./kinds.ts";
import type { VaultKind } from "./kinds.ts";
import { hostOf, VaultService } from "./service.ts";
import { readOneShot } from "./requests.ts";
import type { EphemeralSecrets } from "./ephemeral.ts";
import { totpCode } from "./totp.ts";
import { VAULT_FILL, VAULT_FIND, VAULT_REQUEST, VAULT_TOTP, vaultToolSchemas } from "./tools.ts";

/**
 * The vault's tools, as handlers for the harness's tool loop.
 *
 * What makes a secret safe here is that no handler can return one. `vault_find`
 * returns labels and masked tails; `vault_fill` and `vault_totp` type the value
 * through a `VaultFillSink` and return a sentence; `vault_request` returns "the
 * user provided something" or "no". The model therefore cannot hold a credential,
 * so it cannot repeat one into a transcript, a tool call, a log line or a page it
 * was talked into by that page's own text.
 *
 * The autonomy Ng asked for is in the descriptions: use what is saved when the
 * task needs it, do not ask, do not refuse. The only restraint is the domain check,
 * which is a correctness check enforced in code rather than requested in prose.
 */

/** How long a request card stays answerable before the run gives up on it. */
export const SECRET_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

export interface VaultToolsOptions {
  db: Database;
  vault: VaultService;
  /** The run's one-shot store, so a value provided and not saved is still usable. */
  oneShot?: EphemeralSecrets;
  /** Where a fill lands. Without one, a fill explains that it cannot type. */
  sink?: VaultFillSink;
  /** How this run waits for a person to answer a request card. */
  awaitSecretRequest?: (input: {
    requestId: string;
    timeoutMs: number;
    signal: AbortSignal;
    /** Resolves when the request is no longer pending. */
    status: () => Promise<"pending" | "provided" | "declined" | "expired">;
  }) => Promise<"provided" | "declined" | "expired">;
}

type Handler = (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;

export function vaultTools(options: VaultToolsOptions): RunTool[] {
  const { db, vault, sink } = options;

  const handlers: Record<string, Handler> = {
    [VAULT_FIND]: async (input, context) => {
      const url = stringArg(input, "url");
      const kind = stringArg(input, "kind");
      let host: string;
      try {
        host = hostOf(url);
      } catch (error) {
        return { result: describeVaultError(error) };
      }

      const items = await vault.candidatesForDomain({
        workspaceId: context.workspaceId,
        host,
        ...(isVaultKind(kind) ? { kind } : {}),
      });

      // A value the person provided this run without saving it is listed the same
      // way, under its one-shot id, so a fill can name it like any other item.
      const oneshot = (options.oneShot?.list({ workspaceId: context.workspaceId, host }) ?? []).filter((entry) =>
        isVaultKind(kind) ? entry.kind === kind : true,
      );
      const oneShotLines = oneshot.map(
        (entry) => `- id=${entry.id} kind=${entry.kind} label="${entry.label}" (provided this run, not saved) fields: ${entry.fieldNames.join(", ")}`,
      );

      if (items.length === 0 && oneshot.length === 0) {
        return {
          result: `Nothing is saved for ${host}. If you need a credential for it, call ${VAULT_REQUEST} so the user can add one.`,
        };
      }

      // Ids, labels, masked tails. Never a value, never a ciphertext.
      const lines = items.map((item) => {
        const fields = [`username`, `password`, `number`, `name`].filter((name) =>
          Object.hasOwn(item.meta, name),
        );
        const secret = item.secretFields.join(", ");
        return `- id=${item.id} kind=${item.kind} label="${item.label}"${item.hint ? ` (${item.hint})` : ""} fields: ${[...fields, ...(secret ? [secret] : [])].join(", ")}`;
      });
      return { result: `Saved for ${host}:\n${[...lines, ...oneShotLines].join("\n")}` };
    },

    [VAULT_FILL]: async (input, context) => {
      const url = stringArg(input, "url");
      const itemId = stringArg(input, "itemId");
      const field = stringArg(input, "field");
      const target = stringArg(input, "target");

      if (!itemId || !field || !target || !url) {
        return { result: "a fill needs the item id, the field, the element to type into, and the page URL" };
      }
      if (!sink) {
        // Honest rather than pretending: without a driver there is nothing to type
        // into, and saying "filled" would make a model report work that never happened.
        return { result: "this bot has no computer driver attached, so a value cannot be typed anywhere" };
      }

      try {
        const filled = await fillFromVault(vault, {
          workspaceId: context.workspaceId,
          url,
          itemId,
          field,
          target,
          sink,
          ...(options.oneShot ? { oneShot: options.oneShot } : {}),
        });
        await context.emit({ type: "step", payload: { label: `Filled ${field} on ${filled.host}` } });
        return { result: filled.message };
      } catch (error) {
        return { result: describeVaultError(error) };
      }
    },

    [VAULT_TOTP]: async (input, context) => {
      const url = stringArg(input, "url");
      const itemId = stringArg(input, "itemId");
      const target = stringArg(input, "target");
      if (!itemId || !target || !url) {
        return { result: "a code needs the item id, the element to type into, and the page URL" };
      }
      if (!sink) {
        return { result: "this bot has no computer driver attached, so a code cannot be typed anywhere" };
      }

      try {
        // The domain check is the same one a password fill gets: a code is a
        // credential too, and it only makes sense on the site it belongs to.
        const host = hostOf(url);
        const oneshot = options.oneShot
          ? await readOneShot(options.oneShot, { workspaceId: context.workspaceId, itemId })
          : null;
        const item = oneshot ?? (await vault.get({ workspaceId: context.workspaceId, itemId }));
        if (item.domain && host !== item.domain && !host.endsWith(`.${item.domain}`)) {
          return { result: `that login is saved for ${item.domain} and this page is ${host}` };
        }

        const values = oneshot
          ? oneshot.values
          : (await vault.reveal({ workspaceId: context.workspaceId, itemId, field: "totp" })).values;
        const secret = values.totp;
        if (!secret) return { result: "that login has no 2FA secret saved" };

        const { code, secondsRemaining } = totpCode(secret);
        await sink.fill({ url, target, field: "totp", value: code });
        if (!oneshot) await vault.markUsed(context.workspaceId, itemId);

        // The code is not returned: it is time-derived and single-use, and a model
        // holding it could paste it somewhere else or quote it into the transcript.
        await context.emit({ type: "step", payload: { label: `Entered a 2FA code on ${host}` } });
        return {
          result: `Typed the current 2FA code into ${target} on ${host}. It expires in about ${secondsRemaining} seconds — if the site rejects it, generate another.`,
        };
      } catch (error) {
        return { result: describeVaultError(error) };
      }
    },

    [VAULT_REQUEST]: async (input, context) => {
      const kindRaw = stringArg(input, "kind");
      const reason = stringArg(input, "reason");
      const url = stringArg(input, "url");

      if (!isVaultKind(kindRaw)) return { result: "a request needs kind login, card or contact" };
      if (!reason) return { result: "a request needs a one-sentence reason the user can read" };

      // Asking twice for the same thing in one run is the failure mode Ng named:
      // a model that re-asks after a decline must be told to answer plainly instead.
      const [already] = await db
        .select({ id: secretRequest.id, status: secretRequest.status })
        .from(secretRequest)
        .where(and(eq(secretRequest.runId, context.runId), eq(secretRequest.kind, kindRaw)))
        .limit(1);
      if (already) {
        return {
          result:
            already.status === "declined"
              ? "The user already declined a request for this. Do not ask again: say plainly what you could not do and continue."
              : "You already asked for this in this run. Wait for the card to be answered rather than asking twice.",
        };
      }

      const requestId = newId();
      const expiresAt = new Date(Date.now() + SECRET_REQUEST_TIMEOUT_MS);
      await db.insert(secretRequest).values({
        id: requestId,
        runId: context.runId,
        conversationId: context.conversationId,
        workspaceId: context.workspaceId,
        botId: context.botId,
        kind: kindRaw,
        reason,
        fields: [],
        expiresAt,
      });

      const domain = safeDomain(url);
      await context.emit({
        type: "secret.request",
        payload: {
          requestId,
          kind: kindRaw,
          reason,
          domain,
          expiresAt: expiresAt.toISOString(),
        },
      });

      const waiter = options.awaitSecretRequest;
      if (!waiter) {
        return {
          result:
            "A card asking the user for this is now in the conversation. Do not ask again in this message; the answer arrives as a new message.",
          endRun: true,
        };
      }

      const outcome = await waiter({
        requestId,
        timeoutMs: SECRET_REQUEST_TIMEOUT_MS,
        signal: context.signal,
        status: async () => {
          const [row] = await db
            .select({ status: secretRequest.status })
            .from(secretRequest)
            .where(eq(secretRequest.id, requestId))
            .limit(1);
          return (row?.status ?? "expired") as "pending" | "provided" | "declined" | "expired";
        },
      });

      // The tool result is the whole answer. `provided` deliberately carries no
      // value and no confirmation of what was typed: the value went to the vault.
      if (outcome === "provided") {
        return {
          result: `The user provided the ${kindRaw} through the card and it is available in the vault for ${domain ?? "this site"}. Continue with the task.`,
        };
      }
      if (outcome === "declined") {
        return {
          result: `The user declined to provide a ${kindRaw}. Do not ask again. Say plainly what you cannot do without it and continue with whatever is still possible.`,
        };
      }
      return {
        result: `The request for a ${kindRaw} timed out without an answer. Tell the user it expired and that they can send it again as a new message.`,
      };
    },
  };

  return vaultToolSchemas.map((schema) => {
    const handler = handlers[schema.name];
    if (!handler) throw new Error(`no handler for ${schema.name}`);
    return { schema, handler };
  });
}

function safeDomain(url: string): string | null {
  try {
    return hostOf(url);
  } catch {
    return null;
  }
}

/**
 * A sink that types by running a command on the bot's computer.
 *
 * Cua Driver is the intended implementation and owns its own surface; this is the
 * minimal one the harness needs so the loop is exercisable today, and it keeps the
 * two properties that matter: the value is written to the target's stdin rather
 * than interpolated into a shell command, and it is never logged.
 */
export function typingSink(type: (input: { target: string; value: string }) => Promise<void>): VaultFillSink {
  return {
    fill: async ({ target, value }) => {
      await type({ target, value });
    },
  };
}

/** Exported for the tests: what a tool result may never contain. */
export function assertNoSecretInText(text: string, secrets: string[]): void {
  for (const secret of secrets) {
    if (!secret) continue;
    if (text.includes(secret)) throw new Error("a tool result contained a stored secret");
  }
}

export type { VaultKind };
