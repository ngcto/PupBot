/**
 * Every vault failure, and what each one means for the caller.
 *
 * These messages are shown to a model as a tool result and to a person in the UI,
 * so none of them may contain a secret value, a ciphertext, or a fragment of one.
 * The reason codes are what callers branch on.
 */
export type VaultErrorCode =
  /** No such item in this workspace, or not this person's to read. */
  | "not_found"
  /** The item exists but has no value for the requested field. */
  | "no_field"
  /** The target page's host does not match the item's domain. */
  | "domain_mismatch"
  /** The item has no domain, so a fill cannot be checked and is refused. */
  | "no_domain"
  /** The URL handed to a fill could not be parsed. */
  | "invalid_url"
  /** The stored ciphertext is malformed or was tampered with. */
  | "unreadable"
  /** The requested field is not part of this kind. */
  | "invalid_field"
  /** A field fails validation (empty, too long, wrong characters). */
  | "invalid_value"
  /** The 2FA secret could not produce a code (not base32, too short). */
  | "invalid_totp_secret"
  /** The destination refused the typed value. */
  | "driver_failed";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/**
 * The one string a model ever sees for a refused fill. Written for a model to act
 * on: it says what was refused and why, without naming the stored value.
 */
export function describeVaultError(error: unknown): string {
  if (error instanceof VaultError) return error.message;
  return "the vault could not complete that request";
}
