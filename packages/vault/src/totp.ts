import { generateSync } from "otplib";
import { VaultError } from "./errors.ts";

/**
 * Time-based one-time codes from a stored 2FA secret.
 *
 * A code is derived from the secret and the current time, so it is computed at
 * the moment it is used and never stored, logged or returned to a model: the fill
 * path types it straight into the target field. The only caller that may see a
 * code is a person reading their own vault behind a re-auth prompt.
 *
 * `otplib` handles base32 decoding and the HMAC; we pin the parameters RFC 6238
 * specifies (SHA-1, 6 digits, 30-second step) because that is what every
 * authenticator app a user enrolled with will have used.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ALGORITHM = "sha1";

/** What the person typed, as the base32 the algorithm needs. */
export function normaliseTotpSecret(raw: string): string {
  const stripped = raw.replace(/[\s-]/g, "").toUpperCase();
  let end = stripped.length;
  while (end > 0 && stripped[end - 1] === "=") end -= 1;
  return stripped.slice(0, end);
}

export interface TotpCode {
  code: string;
  /** Seconds until this code stops being accepted. */
  secondsRemaining: number;
}

export function totpCode(secret: string, at: Date = new Date()): TotpCode {
  const normalised = normaliseTotpSecret(secret);
  if (normalised.length < 16) {
    throw new VaultError(
      "invalid_totp_secret",
      "the stored 2FA secret is too short to be a base32 key; re-save it from the site's setup page",
    );
  }

  const epoch = Math.floor(at.getTime() / 1000);
  let code: string;
  try {
    code = generateSync({
      secret: normalised,
      digits: DIGITS,
      algorithm: ALGORITHM,
      period: PERIOD_SECONDS,
      epoch,
    });
  } catch {
    // otplib throws on a non-base32 string; the message is not useful to a model
    // and could echo part of the secret, so it is replaced.
    throw new VaultError("invalid_totp_secret", "the stored 2FA secret is not valid base32");
  }

  return {
    code,
    secondsRemaining: PERIOD_SECONDS - (epoch % PERIOD_SECONDS),
  };
}
