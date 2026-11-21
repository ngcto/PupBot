import { VaultError } from "./errors.ts";
import { fieldOf } from "./kinds.ts";
import { readOneShot } from "./requests.ts";
import { hostOf, type VaultService } from "./service.ts";

/**
 * Getting a stored value into a field the bot is operating.
 *
 * **The design: a fill tool that takes an item id plus a target field, decrypts
 * server-side, and hands the plaintext to the driver without it ever entering the
 * model's context.** The model sees `vault_1` and a field name; the tool result is
 * a sentence that says "filled", never the value. That is why this is not a matter
 * of instructing the model not to repeat a secret: there is no API surface that
 * would let it.
 *
 * The mechanism is the `VaultFillSink` below. Whatever actually types into the UI
 * — Cua Driver over CDP today, a desktop driver tomorrow — is an implementation of
 * that interface, and it receives the plaintext from this module. The tool result
 * is built from `FillResult`, which is defined so it cannot carry a value: its
 * fields are an item id, a field name, a length and a host. A driver that returned
 * the text it typed would have nowhere to put it.
 *
 * Risks, named honestly:
 *
 * - **The driver process sees the plaintext.** It types it, so it must. That is the
 *   shortest path that avoids the model; anything shorter would be the model
 *   typing it. The exposure is bounded to the process that already controls the
 *   field, and it ends when the value is typed.
 * - **The page can read what is in its own field.** No design avoids that: filling
 *   a password into a page means the page has the password. This is why the domain
 *   check below is not optional.
 * - **A screenshot taken right after a fill can contain the value** if the target
 *   site fails to mask its own input. The fill marks the frame so the caller can
 *   suppress that screenshot rather than rely on the site.
 */

/** What a driver must be able to do to accept a secret. */
export interface VaultFillSink {
  /**
   * Type `value` into the field named by `target` on the page at `url`.
   *
   * Called only after the domain check has passed. An implementation must not log
   * the value, must not include it in an error message, and must type rather than
   * paste where the target supports it, so clipboard history never holds it.
   */
  fill(input: { url: string; target: string; field: string; value: string }): Promise<void>;
}

/** A fill's result, shaped so no field can hold a secret. */
export interface FillResult {
  itemId: string;
  kind: string;
  field: string;
  label: string;
  host: string;
  /** The item's masked tail, which is what a model or a log may carry. */
  hint: string | null;
  /** Characters typed. A length is not a value. */
  length: number;
  /** False when the target is a masked input: a screenshot now is safe. */
  mayShowOnScreen: boolean;
  /** A one-line result for the model, with no value in it. */
  message: string;
}

export interface FillRequest {
  workspaceId: string;
  /**
   * Where a one-shot value lives. A value the person provided without saving it is
   * readable here for the run it was provided for, and nowhere else. Omitted in a
   * run that could not have asked for one.
   */
  oneShot?: import("./ephemeral.ts").EphemeralSecrets;
  /** The URL the bot is about to type into. Its host is what the item must match. */
  url: string;
  /** The item the model chose by id. */
  itemId: string;
  /** Which field to type: "password", "username", "number", "cvc", … */
  field: string;
  /** How the driver addresses the field on the page (a selector, a node id, a label). */
  target: string;
  sink: VaultFillSink;
}

/**
 * Fills one field from the vault, refusing anything the item is not for.
 *
 * The domain match is a correctness check, not a policy one: typing a password
 * into the wrong site is a bug that silently hands a credential to a stranger, and
 * it costs four lines to prevent. A subdomain of the item's domain is accepted
 * (`accounts.google.com` for a `google.com` login) because that is how sign-in
 * flows work; anything else, including a lookalike suffix, is not.
 */
export async function fillFromVault(
  vault: VaultService,
  request: FillRequest,
): Promise<FillResult> {
  const host = hostOf(request.url);

  // A one-shot id names the ephemeral store, not a vault row. Reading it here rather
  // than in the tool means one fill path, one domain check, one result shape.
  const oneShot = request.oneShot
    ? await readOneShot(request.oneShot, { workspaceId: request.workspaceId, itemId: request.itemId })
    : null;

  const item = oneShot
    ? {
        id: oneShot.id,
        kind: oneShot.kind,
        label: oneShot.label,
        domain: oneShot.domain,
        hint: null as string | null,
        meta: {} as Record<string, string>,
        secretFields: Object.keys(oneShot.values),
        lastUsedAt: null,
        createdAt: "",
        updatedAt: "",
      }
    : await vault.get({ workspaceId: request.workspaceId, itemId: request.itemId });

  // A password and a card number are bound to the site they were saved for: typing
  // either into a page it does not belong to hands it to a stranger, so a credential
  // with no domain, or one that does not match, is refused. Contact info is profile
  // data, not a credential — it has no single site, so it is only checked when the
  // person recorded one.
  if (item.kind === "contact") {
    if (item.domain && !domainMatches(host, item.domain)) {
      throw new VaultError(
        "domain_mismatch",
        `that contact item is saved for ${item.domain}, and this page is ${host}`,
      );
    }
  } else {
    if (!item.domain) {
      throw new VaultError("no_domain", "that vault item has no site recorded, so a fill cannot be checked");
    }
    if (!domainMatches(host, item.domain)) {
      throw new VaultError(
        "domain_mismatch",
        `that item is saved for ${item.domain}, and this page is ${host}; save a separate item for this site`,
      );
    }
  }

  // Validated against the kind before anything is decrypted: a contact item has no
  // password, and saying so precisely is what lets a model pick a different item.
  if (!fieldOf(item.kind, request.field)) {
    throw new VaultError("invalid_field", `a ${item.kind} item has no "${request.field}" field`);
  }

  // The item is scoped to the workspace, not to one person: a bot fills on behalf of
  // the workspace it acts for. This is the only call that carries a plaintext value
  // out of the database.
  const values = oneShot
    ? oneShot.values
    : (await vault.reveal({ workspaceId: request.workspaceId, itemId: request.itemId })).values;
  const value = values[request.field];
  if (!value) {
    throw new VaultError("no_field", `that item has no ${request.field} saved`);
  }

  await request.sink.fill({ url: request.url, target: request.target, field: request.field, value });
  // A one-shot value has no stored row to timestamp, and marking one used would
  // write the fact that it was used to a table it was never saved to.
  if (!oneShot) await vault.markUsed(request.workspaceId, request.itemId);

  return {
    itemId: item.id,
    kind: item.kind,
    field: request.field,
    label: item.label,
    host,
    hint: item.hint,
    length: value.length,
    mayShowOnScreen: request.field !== "password" && request.field !== "cvc",
    message: `Filled ${fieldLabel(request.field)} from "${item.label}" into ${host}.`,
  };
}

function fieldLabel(field: string): string {
  if (field === "password") return "the password";
  if (field === "username") return "the username";
  if (field === "number") return "the card number";
  if (field === "cvc") return "the security code";
  if (field === "expiry") return "the expiry date";
  return `the ${field.replace(/_/g, " ")}`;
}

/**
 * `a.example.com` matches `example.com`; `example.com.evil.test` does not, and
 * neither does a bare prefix match like `notexample.com`.
 */
export function domainMatches(host: string, itemDomain: string): boolean {
  if (host === itemDomain) return true;
  return host.endsWith(`.${itemDomain}`);
}
