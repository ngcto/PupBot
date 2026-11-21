import { hintFor } from "./kinds.ts";
import type { VaultKind } from "./kinds.ts";

/**
 * Values a person provided for **one run only**, because they unticked "Save to
 * vault".
 *
 * They live in the memory of the process that runs the bot, in a map keyed by the
 * request id the card was rendered from, and they are never written anywhere: not
 * to Postgres, not to a file, not to a log line. When the run ends the entry is
 * dropped, and a restart takes it with it — which is the correct behaviour, because
 * a value the person declined to save must not survive the run it was typed for.
 *
 * This is why the store is a process-local map and not a table: a table would make
 * "not saved" a promise instead of a fact. The cost is that the value can only
 * reach a run in the same process, which is the documented deployment
 * (`RUN_MODE=inline`, the API runs the run) and is stated plainly where the queue
 * deployment is described.
 *
 * The interface is synchronous on purpose. There is no I/O to await, and making it
 * async would invite an implementation that stores the value somewhere durable.
 */

export interface EphemeralEntry {
  id: string;
  workspaceId: string;
  kind: VaultKind;
  label: string;
  /** The site it was provided for, so a fill can be checked exactly like a saved item. */
  domain: string | null;
  /** Masked tail, computed here so a listing never touches the value. */
  hint: string | null;
  secretFields: string[];
  /** Names of the fields held, for `vault_find` to report. */
  fieldNames: string[];
  expiresAt: number;
}

export interface EphemeralSecrets {
  put(input: {
    id: string;
    workspaceId: string;
    kind: VaultKind;
    label: string;
    domain: string | null;
    values: Record<string, string>;
    ttlMs?: number;
  }): EphemeralEntry;
  /** Entries for a host, for one workspace. Never returns values. */
  list(input: { workspaceId: string; host: string }): EphemeralEntry[];
  /** One entry's metadata, without its values. */
  describe(input: { workspaceId: string; id: string }): EphemeralEntry | null;
  /** The values, for a fill. The caller types them and drops them. */
  valuesOf(input: { workspaceId: string; id: string }): Record<string, string> | null;
  /** Drop an entry; used when a run ends. */
  drop(id: string): void;
  /** Drop every entry for a workspace, used when tests tear down. */
  clear(workspaceId?: string): void;
  size(): number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createEphemeralSecrets(now: () => number = Date.now): EphemeralSecrets {
  const entries = new Map<string, { entry: EphemeralEntry; values: Record<string, string> }>();

  const live = (id: string) => {
    const found = entries.get(id);
    if (!found) return null;
    if (found.entry.expiresAt <= now()) {
      entries.delete(id);
      return null;
    }
    return found;
  };

  const sweep = () => {
    for (const id of [...entries.keys()]) live(id);
  };

  return {
    put(input) {
      const expiresAt = now() + (input.ttlMs ?? DEFAULT_TTL_MS);
      const secretKeys = Object.keys(input.values);
      const entry: EphemeralEntry = {
        id: input.id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        label: input.label,
        domain: input.domain,
        hint: hintFor(input.kind, input.values),
        secretFields: secretKeys,
        fieldNames: secretKeys,
        expiresAt,
      };
      entries.set(input.id, { entry, values: { ...input.values } });
      return entry;
    },

    list({ workspaceId, host }) {
      sweep();
      return [...entries.values()]
        .map((stored) => stored.entry)
        .filter((entry) => entry.workspaceId === workspaceId && (!entry.domain || entry.domain === host));
    },

    describe({ workspaceId, id }) {
      const found = live(id);
      if (!found || found.entry.workspaceId !== workspaceId) return null;
      return found.entry;
    },

    valuesOf({ workspaceId, id }) {
      const found = live(id);
      if (!found || found.entry.workspaceId !== workspaceId) return null;
      return { ...found.values };
    },

    drop(id) {
      entries.delete(id);
    },

    clear(workspaceId) {
      if (!workspaceId) entries.clear();
      for (const [id, stored] of [...entries.entries()]) {
        if (stored.entry.workspaceId === workspaceId) entries.delete(id);
      }
    },

    size() {
      sweep();
      return entries.size;
    },
  };
}

/** The id prefix that tells a fill an item is one-shot rather than stored. */
export const EPHEMERAL_PREFIX = "oneshot_";

export function ephemeralIdFor(requestId: string): string {
  return `${EPHEMERAL_PREFIX}${requestId}`;
}

export function isEphemeralId(value: string): boolean {
  return value.startsWith(EPHEMERAL_PREFIX);
}
