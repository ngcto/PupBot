import { secretRequest, type Database } from "@terabot/db";
import { and, eq, lt } from "drizzle-orm";
import { EPHEMERAL_PREFIX, createEphemeralSecrets, ephemeralIdFor, isEphemeralId } from "./ephemeral.ts";
import type { EphemeralSecrets } from "./ephemeral.ts";
import { VaultError } from "./errors.ts";
import { fieldsOf, isVaultKind } from "./kinds.ts";
import type { VaultKind } from "./kinds.ts";
import { VaultService, normaliseDomain } from "./service.ts";

/**
 * The ask-the-user card's lifecycle.
 *
 * A bot that needs a credential it cannot get itself calls `vault_request`; a row
 * lands here and a card appears in the conversation. The person answers it once:
 *
 * - **Confirm** submits what they typed. With "Save to vault" ticked (the default)
 *   the value is written through `VaultService`, the same encryption path every
 *   other item uses, and the row records which item it became. Unticked, the value
 *   goes into the ephemeral store keyed to the request and is written nowhere —
 *   `secret_request` never has a column that could hold it.
 * - **Decline** resolves the request with no value at all.
 *
 * Either way the request's status is the entire answer the model gets. There is no
 * read path that returns a value to a bot: a fill reads the vault item, or the
 * ephemeral entry, and types it.
 */

let ephemeral: EphemeralSecrets | undefined;

/**
 * The process's one-shot store.
 *
 * Deliberately a single instance per process: a value provided for a run is read by
 * the fill tool in the same process that accepted it, and duplicating the store
 * would mean a value typed in one copy and looked for in another.
 */
export function oneShotSecrets(): EphemeralSecrets {
  ephemeral ??= createEphemeralSecrets();
  return ephemeral;
}

/** Tests replace the store; production never does. */
export function setOneShotSecrets(store: EphemeralSecrets | undefined): void {
  ephemeral = store;
}

export interface SecretRequestView {
  id: string;
  runId: string;
  kind: VaultKind;
  reason: string;
  status: "pending" | "provided" | "declined" | "expired";
  domain: string | null;
  expiresAt: string;
  /** True when the request can still be answered right now. */
  open: boolean;
}

export interface SubmitInput {
  workspaceId: string;
  requestId: string;
  /** The person answering, so a saved item belongs to them. */
  userId: string;
  /** Blank secret fields are ignored, which lets an optional 2FA key stay empty. */
  values: Record<string, string>;
  /** The card's checkbox. Checked by default in the UI. */
  saveToVault: boolean;
  /** Label for the saved item, and for the one-shot entry's list line. */
  label?: string;
  /** Where the credential is for, recorded on the saved item so a fill is checkable. */
  domain?: string | null;
}

export class SecretRequestService {
  readonly #db: Database;
  readonly #vault: VaultService;
  readonly #secrets: EphemeralSecrets;

  constructor(db: Database, options: { vault?: VaultService; secrets?: EphemeralSecrets } = {}) {
    this.#db = db;
    this.#vault = options.vault ?? new VaultService(db);
    this.#secrets = options.secrets ?? oneShotSecrets();
  }

  /** One request, scoped to a workspace. */
  async get(input: { workspaceId: string; requestId: string }): Promise<SecretRequestView> {
    const [row] = await this.#db
      .select()
      .from(secretRequest)
      .where(and(eq(secretRequest.id, input.requestId), eq(secretRequest.workspaceId, input.workspaceId)))
      .limit(1);
    if (!row) throw new VaultError("not_found", "that request is not in this workspace");
    return this.#view(row);
  }

  /**
   * Expires anything past its deadline. Called before a read so a card that timed
   * out can never be answered, and by the run when it gives up waiting.
   */
  async expireOverdue(input: { workspaceId?: string; requestId?: string } = {}): Promise<number> {
    const clauses = [
      eq(secretRequest.status, "pending"),
      lt(secretRequest.expiresAt, new Date()),
      ...(input.workspaceId ? [eq(secretRequest.workspaceId, input.workspaceId)] : []),
      ...(input.requestId ? [eq(secretRequest.id, input.requestId)] : []),
    ];
    const updated = await this.#db
      .update(secretRequest)
      .set({ status: "expired", resolvedAt: new Date() })
      .where(and(...clauses))
      .returning({ id: secretRequest.id });
    return updated.length;
  }

  /**
   * The person answered. Writes the value where the checkbox says it goes, then
   * resolves the request. The status is the only thing a run ever reads back.
   */
  async submit(input: SubmitInput): Promise<{ status: "provided"; vaultItemId: string | null }> {
    await this.expireOverdue({ workspaceId: input.workspaceId, requestId: input.requestId });
    const row = await this.#openRow(input);

    const kind = isVaultKind(row.kind) ? row.kind : "login";
    const values = cleanValues(kind, input.values);
    if (Object.keys(values).length === 0) {
      throw new VaultError("invalid_value", "fill in at least one field, or decline the request");
    }

    const domain = normaliseDomain(input.domain ?? null);
    const label = (input.label ?? "").trim() || defaultLabel(kind, values, domain);

    let vaultItemId: string | null = null;
    if (input.saveToVault) {
      const item = await this.#vault.create({
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind,
        label,
        domain,
        // A credential kind requires a domain; the request row does not have one of
        // its own, so the card carries it and this is where it is enforced.
        values,
      });
      vaultItemId = item.id;
    } else {
      // One-shot: held in memory for this run only, under an id a fill can name.
      this.#secrets.put({
        id: ephemeralIdFor(input.requestId),
        workspaceId: input.workspaceId,
        kind,
        label,
        domain,
        values,
      });
    }

    await this.#db
      .update(secretRequest)
      .set({ status: "provided", vaultItemId, resolvedAt: new Date() })
      .where(eq(secretRequest.id, input.requestId));

    return { status: "provided", vaultItemId };
  }

  /** The person said no. Nothing is written anywhere. */
  async decline(input: { workspaceId: string; requestId: string }): Promise<{ status: "declined" }> {
    await this.expireOverdue({ workspaceId: input.workspaceId, requestId: input.requestId });
    await this.#openRow(input);
    await this.#db
      .update(secretRequest)
      .set({ status: "declined", resolvedAt: new Date() })
      .where(eq(secretRequest.id, input.requestId));
    return { status: "declined" };
  }

  /**
   * Drop every one-shot value a run held. Called when the run ends, however it
   * ended: a value the person declined to save must not outlive the run it was
   * typed for, and this is the only thing that keeps that true past a crash-free end.
   */
  async releaseRun(input: { runId: string }): Promise<void> {
    const rows = await this.#db
      .select({ id: secretRequest.id })
      .from(secretRequest)
      .where(eq(secretRequest.runId, input.runId));
    for (const row of rows) this.#secrets.drop(ephemeralIdFor(row.id));
  }

  async #openRow(input: { workspaceId: string; requestId: string }) {
    const [row] = await this.#db
      .select()
      .from(secretRequest)
      .where(and(eq(secretRequest.id, input.requestId), eq(secretRequest.workspaceId, input.workspaceId)))
      .limit(1);
    if (!row) throw new VaultError("not_found", "that request is not in this workspace");
    if (row.status !== "pending") {
      throw new VaultError("invalid_value", `that request was already ${row.status}`);
    }
    return row;
  }

  #view(row: typeof secretRequest.$inferSelect, domain: string | null = null): SecretRequestView {
    return {
      id: row.id,
      runId: row.runId,
      kind: isVaultKind(row.kind) ? row.kind : "login",
      reason: row.reason,
      status: row.status,
      domain,
      expiresAt: row.expiresAt.toISOString(),
      open: row.status === "pending" && row.expiresAt.getTime() > Date.now(),
    };
  }
}

/**
 * One-shot ids are not vault ids, so a fill has to know which store to read. This is
 * the single place that decides, which keeps the tool code unaware of the split.
 */
export async function readOneShot(
  secrets: EphemeralSecrets,
  input: { workspaceId: string; itemId: string },
): Promise<{ id: string; kind: VaultKind; label: string; domain: string | null; values: Record<string, string> } | null> {
  if (!isEphemeralId(input.itemId)) return null;
  const values = secrets.valuesOf({ workspaceId: input.workspaceId, id: input.itemId });
  if (!values) return null;
  const described = secrets.describe({ workspaceId: input.workspaceId, id: input.itemId });
  if (!described) return null;
  return {
    id: input.itemId,
    kind: described.kind,
    label: described.label,
    domain: described.domain,
    values,
  };
}

/** Only the fields the kind declares, only non-blank ones. */
function cleanValues(kind: VaultKind, raw: Record<string, string>): Record<string, string> {
  const declared = new Set(fieldsOf(kind).map((field) => field.name));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!declared.has(name)) continue;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) out[name] = trimmed;
  }
  return out;
}

function defaultLabel(kind: VaultKind, values: Record<string, string>, domain: string | null): string {
  if (kind === "contact") return values.name ?? "Contact info";
  if (kind === "card") return values.holder ? `${values.holder}'s card` : "Payment card";
  return domain ?? values.username ?? "Login";
}

export { EPHEMERAL_PREFIX };
export type { EphemeralSecrets };
