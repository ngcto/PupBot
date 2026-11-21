import { describe, expect, it } from "vitest";
import { VaultError } from "../src/errors.ts";
import { normaliseTotpSecret, totpCode } from "../src/totp.ts";

/**
 * RFC 6238's own test vectors, Appendix B, at the SHA-1 seed. This is the check
 * that our parameters match what every authenticator app produced when the user
 * enrolled: if these drift, a correct secret silently generates wrong codes.
 *
 * The seed from the RFC is ASCII "12345678901234567890", base32-encoded — the same
 * shape as the key a site shows you.
 */
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const VECTORS: Array<[seconds: number, code: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totpCode against RFC 6238", () => {
  for (const [seconds, expected] of VECTORS) {
    it(`matches the RFC vector at T=${seconds}`, () => {
      // The RFC publishes 8 digits; we ask for the first 6 of the same HMAC, so the
      // expected value is its last 6 digits (truncation keeps the low digits).
      const result = totpCode(RFC_SEED, new Date(seconds * 1000));
      expect(result.code).toBe(expected.slice(-6));
      expect(result.code).toHaveLength(6);
    });
  }

  it("changes across a 30-second boundary and reports the time left", () => {
    const early = totpCode(RFC_SEED, new Date(1_111_111_109 * 1000));
    const next = totpCode(RFC_SEED, new Date(1_111_111_109_000 + 30_000));
    expect(early.code).not.toBe(next.code);
    expect(early.secondsRemaining).toBe(30 - (1_111_111_109 % 30));
  });

  it("accepts the spacing an authenticator setup page prints", () => {
    const spaced = totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", new Date(59_000));
    expect(spaced.code).toBe(totpCode(RFC_SEED, new Date(59_000)).code);
  });

  it("strips trailing base32 padding", () => {
    expect(normaliseTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ===")).toBe(RFC_SEED);
  });

  it("refuses a secret too short to be a key, without echoing it", () => {
    try {
      totpCode("ABC");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe("invalid_totp_secret");
      expect((error as VaultError).message).not.toContain("ABC");
    }
  });

  it("refuses a value that is not base32", () => {
    expect(() => totpCode("this is not base32 !!!")).toThrow(VaultError);
  });
});
