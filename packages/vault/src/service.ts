import { encryptSecret, decryptSecret, vaultItem, newId } from "@terabot/db";
import type { Database } from "@terabot/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { VaultError } from "./errors.ts";
import { VAULT_KINDS, fieldOf, fieldsOf, hintFor, isVaultKind } from "./kinds.ts";
import type { VaultKind } from "./kinds.ts";

/**
 * The vault's storage layer. Everything that reads or writes a stored credential
 * goes through this module, so there is exactly one place that encrypts, exactly
 * one that decrypts, and exactly one that decides what may leave as ciphertext.
 *
 * Two rules this module enforces by construction rather than by convention:
 *
 * 1. **A secret never crosses the wire to a model.** `toView` returns a row with
 *    the ciphertext dropped and only `meta` plus a pre-computed `hint` — so a
 *    listing surface, a tool result, or a log line can only ever carry a masked
 *    tail. The only functions that return plaintext take an explicit item id and
 *    are called by the fill path, which types the value instead of returning it.
 * 2. **A value that is not a secret is still not free text.** `meta` is narrowed
 *    to the fields the kind declares; a payload with an unexpected key is
 *    refused rather than stored.
 */

export interface VaultItemView {
  id: string;
  kind: VaultKind;
  label: string;
  domain: string | null;
  /** Masked tail, e.g. "•••• 4242". Never a secret. */
  hint: string | null;
  /** Non-secret fields, ready to render. */
  meta: Record<string, string>;
  /** Names of the secret fields this item actually holds values for. */
  secretFields: string[];
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultItemInput {
  kind: VaultKind;
  label: string;
  /** Hostname the item belongs to. Required for login and card: a fill needs it. */
  domain?: string | null;
  /** Every field the person filled in, secret and plain alike, in the clear. */
  values: Record<string, string>;
}

const MAX_LABEL = 120;

/**
 * "github.com", from whatever the person typed — a bare host, a URL, or a URL with
 * a path. Stored lowercased without a leading `www.` so the comparison at fill
 * time is about the site, not about how it was written down.
 */
export function normaliseDomain(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname.includes(".")) return null;
  return hostname.replace(/^www\./, "");
}

/** Hostname of a URL a bot is about to fill, in the same shape `normaliseDomain` produces. */
export function hostOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VaultError("invalid_url", "that is not a URL this vault can check a fill against");
  }
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

function cleanValue(kind: VaultKind, name: string, raw: unknown): string {
  const field = fieldOf(kind, name);
  if (!field) throw new VaultError("invalid_field", `"${name}" is not a field of a ${kind}`);
  if (typeof raw !== "string") throw new VaultError("invalid_value", `${field.label} must be text`);
  const value = raw.trim();
  if (value.length > field.maxLength) {
    throw new VaultError("invalid_value", `${field.label} is longer than ${field.maxLength} characters`);
  }
  return value;
}

/**
 * Splits submitted values into the two stored halves and validates what the kind
 * requires. Blank optional fields are dropped rather than stored as "".
 */
function partition(kind: VaultKind, values: Record<string, string>): {
  meta: Record<string, string>;
  plaintextSecrets: Record<string, string>;
} {
  const declared = new Set(fieldsOf(kind).map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new VaultError("invalid_field", `"${name}" is not a field of a ${kind}`);
  }

  const meta: Record<string, string> = {};
  const plaintextSecrets: Record<string, string> = {};

  for (const field of fieldsOf(kind)) {
    const value = cleanValue(kind, field.name, values[field.name] ?? "");
    if (!value) {
      if (field.optional) continue;
      throw new VaultError("invalid_value", `${field.label} is required`);
    }
    if (field.secret) plaintextSecrets[field.name] = value;
    else meta[field.name] = value;
  }

  return { meta, plaintextSecrets };
}

/**
 * Card numbers and expiries are stored digits-only, so a fill never depends on how
 * the person grouped them. Spaces are how people type a number, not data.
 */
function normaliseForStorage(kind: VaultKind, values: Record<string, string>): Record<string, string> {
  if (kind !== "card") return values;
  const next = { ...values };
  if (next.number) next.number = next.number.replace(/\D/g, "");
  if (next.expiry) {
    const digits = next.expiry.replace(/\D/g, "").slice(0, 4);
    next.expiry = digits.length === 4 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  }
  return next;
}

function view(row: typeof vaultItem.$inferSelect): VaultItemView {
  const kind = isVaultKind(row.kind) ? row.kind : "login";
  const secrets = row.secrets ?? {};
  return {
    id: row.id,
    kind,
    label: row.label,
    domain: row.domain,
    hint: row.hint,
    meta: row.meta ?? {},
    // Only which fields are present, never the ciphertext that holds them.
    secretFields: fieldsOf(kind)
      .filter((field) => field.secret && typeof secrets[field.name] === "string")
      .map((field) => field.name),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class VaultService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async list(input: { workspaceId: string; userId: string; kind?: VaultKind }): Promise<VaultItemView[]> {
    const rows = await this.#db
      .select()
      .from(vaultItem)
      .where(
        input.kind
          ? and(
              eq(vaultItem.workspaceId, input.workspaceId),
              eq(vaultItem.userId, input.userId),
              eq(vaultItem.kind, input.kind),
            )
          : and(eq(vaultItem.workspaceId, input.workspaceId), eq(vaultItem.userId, input.userId)),
      )
      .orderBy(desc(vaultItem.updatedAt));
    return rows.map(view);
  }

  /** `userId: undefined` scopes to the workspace, which is how a bot reads its own vault. */
  async get(input: { workspaceId: string; userId?: string; itemId: string }): Promise<VaultItemView> {
    return view(await this.#row(input));
  }

  async create(input: { workspaceId: string; userId: string } & VaultItemInput): Promise<VaultItemView> {
    if (!isVaultKind(input.kind)) throw new VaultError("invalid_field", "unknown vault item kind");
    const values = normaliseForStorage(input.kind, input.values);
    const { meta, plaintextSecrets } = partition(input.kind, values);
    const domain = this.#domainFor(input.kind, input.domain ?? meta.username ?? meta.number ?? null);
    const label = input.label.trim().slice(0, MAX_LABEL) || defaultLabel(input.kind, meta);

    const [row] = await this.#db
      .insert(vaultItem)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: input.kind,
        label,
        domain,
        hint: hintFor(input.kind, values),
        meta,
        secrets: encryptAll(plaintextSecrets),
      })
      .returning();

    return view(row!);
  }

  /**
   * Editing replaces the whole payload. A secret field left blank means "keep what
   * is stored", because a form can never show the current value: the browser would
   * have to hold it, and that is exactly what this design forbids.
   */
  async update(input: {
    workspaceId: string;
    userId: string;
    itemId: string;
    label?: string;
    domain?: string | null;
    values?: Record<string, string>;
  }): Promise<VaultItemView> {
    const existing = await this.#row(input);
    const kind = isVaultKind(existing.kind) ? existing.kind : "login";

    let meta = existing.meta ?? {};
    let secrets = existing.secrets ?? {};
    let hint = existing.hint;
    let domain = existing.domain;

    if (input.values) {
      const merged: Record<string, string> = { ...input.values };
      for (const field of fieldsOf(kind)) {
        if (field.secret && !merged[field.name]?.trim()) delete merged[field.name];
      }
      const values = normaliseForStorage(kind, merged);
      const partitioned = partitionForUpdate(kind, values, secrets);
      meta = partitioned.meta;
      secrets = partitioned.secrets;
      hint = hintFor(kind, { ...decryptAll(secrets, kind), ...meta });
    }

    if (input.domain !== undefined) domain = this.#domainFor(kind, input.domain);

    const [row] = await this.#db
      .update(vaultItem)
      .set({
        ...(input.label?.trim() ? { label: input.label.trim().slice(0, MAX_LABEL) } : {}),
        meta,
        secrets,
        hint,
        domain,
        updatedAt: new Date(),
      })
      .where(and(eq(vaultItem.id, input.itemId), eq(vaultItem.workspaceId, input.workspaceId)))
      .returning();

    return view(row!);
  }

  async remove(input: { workspaceId: string; userId: string; itemId: string }): Promise<void> {
    await this.#row(input);
    await this.#db
      .delete(vaultItem)
      .where(and(eq(vaultItem.id, input.itemId), eq(vaultItem.workspaceId, input.workspaceId)));
  }

  /**
   * Decrypted values for one item, keyed by field name. The only read of plaintext
   * in the system, and it exists for two callers: the fill path, which types the
   * value and discards it, and a person's own reveal behind re-auth.
   *
   * It never returns a partial decrypt: a tampered payload throws, because handing
   * back a truncated secret would fill a field with garbage and look like success.
   */
  async reveal(input: {
    workspaceId: string;
    /** Omitted by the fill path: a bot reads the vault of the workspace it acts for. */
    userId?: string;
    itemId: string;
    field?: string;
  }): Promise<{ kind: VaultKind; values: Record<string, string> }> {
    const row = await this.#row(input);
    const kind = isVaultKind(row.kind) ? row.kind : "login";
    if (input.field && !fieldOf(kind, input.field)) {
      throw new VaultError("invalid_field", `"${input.field}" is not a field of a ${kind}`);
    }

    const stored = row.secrets ?? {};
    const values: Record<string, string> = { ...(row.meta ?? {}) };
    for (const [name, payload] of Object.entries(stored)) {
      if (input.field && name !== input.field) continue;
      try {
        values[name] = decryptSecret(payload);
      } catch {
        // Do not let a wrong-key or tampered row leak which of the two it was.
        throw new VaultError("unreadable", "that stored value could not be decrypted; re-save it");
      }
    }

    if (input.field && values[input.field] === undefined) {
      throw new VaultError("no_field", `that item has no ${input.field} saved`);
    }

    return { kind, values };
  }

  /**
   * Items a bot may consider for a host. Scoped to the workspace: a bot acts for
   * its workspace, so a stored login is available to it exactly as the person's own
   * vault would be. Never returns a value.
   */
  async candidatesForDomain(input: {
    workspaceId: string;
    host: string;
    kind?: VaultKind;
  }): Promise<VaultItemView[]> {
    const rows = await this.#db
      .select()
      .from(vaultItem)
      .where(
        input.kind
          ? and(
              eq(vaultItem.workspaceId, input.workspaceId),
              eq(vaultItem.domain, input.host),
              eq(vaultItem.kind, input.kind),
            )
          : and(eq(vaultItem.workspaceId, input.workspaceId), eq(vaultItem.domain, input.host)),
      )
      .orderBy(desc(vaultItem.updatedAt));
    return rows.map(view);
  }

  async markUsed(workspaceId: string, itemId: string): Promise<void> {
    await this.#db
      .update(vaultItem)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(vaultItem.id, itemId), eq(vaultItem.workspaceId, workspaceId)));
  }

  readonly #row = async (input: { workspaceId: string; userId?: string; itemId: string }) => {
    const rows = await this.#db
      .select()
      .from(vaultItem)
      .where(
        input.userId
          ? and(
              eq(vaultItem.id, input.itemId),
              eq(vaultItem.workspaceId, input.workspaceId),
              eq(vaultItem.userId, input.userId),
            )
          : and(eq(vaultItem.id, input.itemId), eq(vaultItem.workspaceId, input.workspaceId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new VaultError("not_found", "that vault item is not in this workspace");
    return row;
  };

  /**
   * A login or card with no domain would be a fillable secret with no site it
   * belongs to, and the fill guard could not check it. Both kinds therefore have to
   * name one; contact info does not, because filling an address into a form is not
   * a credential leaving the machine.
   */
  #domainFor(kind: VaultKind, raw: string | null | undefined): string | null {
    const domain = normaliseDomain(raw);
    if (kind === "contact") return domain;
    if (!domain) {
      throw new VaultError(
        "no_domain",
        `a ${VAULT_KINDS[kind].label.toLowerCase()} needs the site it belongs to, like "github.com"`,
      );
    }
    return domain;
  }
}

function encryptAll(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) out[name] = encryptSecret(value);
  return out;
}

function decryptAll(ciphertext: Record<string, string>, kind: VaultKind): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fieldsOf(kind)) {
    if (!field.secret) continue;
    const payload = ciphertext[field.name];
    if (!payload) continue;
    try {
      out[field.name] = decryptSecret(payload);
    } catch {
      // A hint computed from an unreadable payload is not worth failing an edit for.
    }
  }
  return out;
}

/** Update semantics: a blank secret keeps the stored one, a supplied one re-encrypts. */
function partitionForUpdate(
  kind: VaultKind,
  values: Record<string, string>,
  existingSecrets: Record<string, string>,
): { meta: Record<string, string>; secrets: Record<string, string> } {
  const declared = new Set(fieldsOf(kind).map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new VaultError("invalid_field", `"${name}" is not a field of a ${kind}`);
  }

  const meta: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const field of fieldsOf(kind)) {
    const supplied = values[field.name];
    if (field.secret) {
      const prior = existingSecrets[field.name];
      if (supplied) secrets[field.name] = encryptSecret(supplied);
      else if (prior) secrets[field.name] = prior;
      continue;
    }
    const value = cleanValue(kind, field.name, supplied ?? "");
    if (!value && !field.optional) throw new VaultError("invalid_value", `${field.label} is required`);
    if (value) meta[field.name] = value;
  }

  return { meta, secrets };
}

function defaultLabel(kind: VaultKind, meta: Record<string, string>): string {
  if (kind === "contact") return meta.name ?? "Contact info";
  if (kind === "card") return meta.holder ? `${meta.holder}'s card` : "Payment card";
  return meta.username ?? "Login";
}

/** Count of how many items a workspace holds, for the settings row. */
export async function vaultCount(db: Database, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vaultItem)
    .where(eq(vaultItem.workspaceId, workspaceId));
  return row?.count ?? 0;
}
