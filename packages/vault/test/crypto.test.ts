import { decryptSecret, encryptSecret } from "@terabot/db";
import { describe, expect, it } from "vitest";
import { VaultError } from "../src/errors.ts";
import { domainMatches } from "../src/fill.ts";
import { normaliseDomain, hostOf } from "../src/service.ts";
import { hintFor, fieldsOf } from "../src/kinds.ts";

/**
 * The encryption path the whole vault rests on. These run without a database: the
 * point is the ciphertext itself, which is what an attacker with a database dump
 * would have.
 */

describe("vault item values at rest", () => {
  it("decrypts a stored value back to what was written", () => {
    const stored = encryptSecret("correct-horse-battery-staple");
    expect(stored).not.toContain("correct-horse");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptSecret(stored)).toBe("correct-horse-battery-staple");
  });

  it("produces a different ciphertext for the same value every time", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("fails on a tampered payload instead of returning a partial value", () => {
    const stored = encryptSecret("4111111111111111");
    const [version, iv, tag, ciphertext] = stored.split(":");

    // Flip one base64 character of the ciphertext: the GCM tag no longer matches.
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString("base64")].join(":");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("fails when the auth tag is replaced", () => {
    const stored = encryptSecret("hunter2-fake");
    const [version, iv, tag, ciphertext] = stored.split(":");
    const swappedTag = Buffer.from(tag!, "base64");
    swappedTag[0] = swappedTag[0]! ^ 0xff;
    expect(() => decryptSecret([version, iv, swappedTag.toString("base64"), ciphertext].join(":"))).toThrow();
  });

  it("refuses a payload that is not in the expected format", () => {
    expect(() => decryptSecret("not-a-payload")).toThrow(/expected format/);
  });

  it("keeps the masked hint derived from the value without storing the value", () => {
    expect(hintFor("card", { number: "4111111111111111" })).toBe("•••• 1111");
    expect(hintFor("login", { password: "abcdefgh" })).toBe("•••• efgh");
    expect(hintFor("contact", { email: "a@b.test" })).toBeNull();
  });
});

describe("the domain a fill is checked against", () => {
  it("normalises what a person types into a bare host", () => {
    expect(normaliseDomain("github.com")).toBe("github.com");
    expect(normaliseDomain("https://GitHub.com/login?next=/x")).toBe("github.com");
    expect(normaliseDomain("www.github.com")).toBe("github.com");
    expect(normaliseDomain("  https://www.GitHub.com  ")).toBe("github.com");
  });

  it("refuses a value that is not a host", () => {
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("localhost")).toBeNull();
    expect(normaliseDomain("not a domain")).toBeNull();
  });

  it("matches a subdomain of the saved site but nothing else", () => {
    expect(domainMatches("github.com", "github.com")).toBe(true);
    expect(domainMatches("accounts.google.com", "google.com")).toBe(true);
    expect(domainMatches("gist.github.com", "github.com")).toBe(true);

    // The three ways a lookalike gets through a careless check.
    expect(domainMatches("github.com.evil.test", "github.com")).toBe(false);
    expect(domainMatches("notgithub.com", "github.com")).toBe(false);
    expect(domainMatches("evil.test", "github.com")).toBe(false);
    expect(domainMatches("google.com", "mail.google.com")).toBe(false);
  });

  it("reads the host of a URL the bot is about to fill", () => {
    expect(hostOf("https://www.github.com/session")).toBe("github.com");
    expect(() => hostOf("not a url")).toThrow(VaultError);
  });
});

describe("kind definitions", () => {
  it("marks every credential field secret and leaves profile data plain", () => {
    const login = fieldsOf("login");
    expect(login.find((field) => field.name === "password")?.secret).toBe(true);
    expect(login.find((field) => field.name === "totp")?.secret).toBe(true);
    expect(login.find((field) => field.name === "username")?.secret).toBe(false);

    for (const name of ["number", "expiry", "cvc"]) {
      expect(fieldsOf("card").find((field) => field.name === name)?.secret).toBe(true);
    }
    expect(fieldsOf("card").find((field) => field.name === "holder")?.secret).toBe(false);

    expect(fieldsOf("contact").every((field) => !field.secret)).toBe(true);
  });
});
