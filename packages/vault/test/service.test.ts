import { loadEnv } from "@terabot/config/load-env";
import { decryptSecret, newId, vaultItem, workspace, user } from "@terabot/db";
import { createDatabase } from "@terabot/db";
import type { DatabaseHandle } from "@terabot/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultError } from "../src/errors.ts";
import { domainMatches, fillFromVault } from "../src/fill.ts";
import { VaultService } from "../src/service.ts";
import type { FillEffect, VaultFillSink } from "../src/fill.ts";

loadEnv();

/**
 * The service against a real database. The unit tests prove the ciphertext; this
 * proves what is actually on disk after a save, which is the claim that matters:
 * a database dump holds no usable credential.
 */

let handle: DatabaseHandle;
let vault: VaultService;
let workspaceId: string;
let userId: string;

const PASSWORD = "fake-password-not-real-9f2";
const CARD = "4000000000000002"; // Stripe's decline test number: obviously a fake.

beforeAll(async () => {
  handle = createDatabase(
    process.env.DATABASE_URL ?? "postgres://terabot:terabot@localhost:5432/terabot",
    2,
  );
  vault = new VaultService(handle.db);

  userId = newId();
  await handle.db.insert(user).values({
    id: userId,
    name: "Vault Fixture",
    email: `vault-fixture-${userId}@terabot.test`,
  });
  workspaceId = newId();
  await handle.db.insert(workspace).values({ id: workspaceId, ownerId: userId, name: "Vault fixture" });
});

afterAll(async () => {
  // The workspace cascade takes the vault items and the user with it.
  await handle.db.delete(user).where(eq(user.id, userId));
  await handle.close();
});

describe("saving a login", () => {
  it("stores the password as ciphertext, not plaintext", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "GitHub",
      domain: "https://github.com/login",
      values: { username: "octocat", password: PASSWORD },
    });

    const [row] = await handle.db.select().from(vaultItem).where(eq(vaultItem.id, item.id));
    expect(row).toBeDefined();

    // The whole row, serialised, must not contain the password anywhere.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain("fake-password");

    // What is stored is a v1 AES-256-GCM payload that decrypts back.
    expect(row!.secrets.password).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decryptSecret(row!.secrets.password!)).toBe(PASSWORD);
  });

  it("keeps the non-secret fields readable and the domain normalised", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "GitLab",
      domain: "www.gitlab.com",
      values: { username: "octocat", password: PASSWORD },
    });
    expect(item.domain).toBe("gitlab.com");
    expect(item.meta.username).toBe("octocat");
    expect(item.hint).toBe("•••• -9f2");
    expect(item.secretFields).toContain("password");
  });

  it("never returns ciphertext or plaintext in a view", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Reddit",
      domain: "reddit.com",
      values: { username: "octocat", password: PASSWORD },
    });
    const listed = await vault.list({ workspaceId, userId });
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain("v1:");
    expect(listed.find((entry) => entry.id === item.id)?.secretFields).toEqual(["password"]);
  });

  it("requires a domain for a login, because a fill cannot be checked without one", async () => {
    await expect(
      vault.create({
        workspaceId,
        userId,
        kind: "login",
        label: "Nowhere",
        values: { username: "octocat", password: PASSWORD },
      }),
    ).rejects.toMatchObject({ code: "no_domain" });
  });

  it("refuses a field the kind does not have", async () => {
    await expect(
      vault.create({
        workspaceId,
        userId,
        kind: "login",
        label: "Odd",
        domain: "example.test",
        values: { username: "octocat", password: PASSWORD, ssn: "000-00-0000" },
      }),
    ).rejects.toMatchObject({ code: "invalid_field" });
  });

  it("refuses an empty password", async () => {
    await expect(
      vault.create({
        workspaceId,
        userId,
        kind: "login",
        label: "Empty",
        domain: "example.test",
        values: { username: "octocat", password: "   " },
      }),
    ).rejects.toMatchObject({ code: "invalid_value" });
  });
});

describe("saving a card", () => {
  it("stores number, expiry and CVC encrypted and digits-only", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "card",
      label: "Test card",
      domain: "shop.example.test",
      values: { holder: "Ada Lovelace", number: "4000 0000 0000 0002", expiry: "12 / 29", cvc: "737" },
    });

    const [row] = await handle.db.select().from(vaultItem).where(eq(vaultItem.id, item.id));
    expect(JSON.stringify(row)).not.toContain("4000");
    expect(decryptSecret(row!.secrets.number!)).toBe(CARD);
    expect(decryptSecret(row!.secrets.expiry!)).toBe("12/29");
    expect(row!.meta.holder).toBe("Ada Lovelace");
    expect(item.hint).toBe("•••• 0002");
  });
});

describe("editing an item", () => {
  it("keeps a stored secret when the field is left blank", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Keep me",
      domain: "keep.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const edited = await vault.update({
      workspaceId,
      userId,
      itemId: item.id,
      label: "Kept",
      values: { username: "octocat-changed", password: "" },
    });

    expect(edited.label).toBe("Kept");
    expect(edited.meta.username).toBe("octocat-changed");
    const { values } = await vault.reveal({ workspaceId, userId, itemId: item.id });
    expect(values.password).toBe(PASSWORD);
  });

  it("re-encrypts when a new secret is supplied", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Rotate",
      domain: "rotate.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    await vault.update({
      workspaceId,
      userId,
      itemId: item.id,
      values: { username: "octocat", password: "a-brand-new-fake-password" },
    });
    const { values } = await vault.reveal({ workspaceId, userId, itemId: item.id });
    expect(values.password).toBe("a-brand-new-fake-password");
  });
});

describe("a tampered row", () => {
  it("reports the value as unreadable instead of returning a fragment", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Tampered",
      domain: "tamper.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const [row] = await handle.db.select().from(vaultItem).where(eq(vaultItem.id, item.id));
    const [version, iv, tag, ciphertext] = row!.secrets.password!.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;

    await handle.db
      .update(vaultItem)
      .set({ secrets: { ...row!.secrets, password: [version, iv, tag, flipped.toString("base64")].join(":") } })
      .where(eq(vaultItem.id, item.id));

    await expect(vault.reveal({ workspaceId, userId, itemId: item.id })).rejects.toMatchObject({
      code: "unreadable",
    });
  });
});

describe("filling from the vault", () => {
  /** A sink that records what it was handed and reports a given effect. */
  async function sinkRecorder(effect: FillEffect = "confirmed") {
    const typed: Array<{ field: string; value: string; url: string; token: string; snapshotId: string }> = [];
    const sink: VaultFillSink = {
      fill: async (input) => {
        typed.push({
          field: input.field,
          value: input.value,
          url: input.url,
          token: input.target.token,
          snapshotId: input.target.snapshotId,
        });
        return { effect, verified: effect === "confirmed", evidence: "the field now shows 12 characters" };
      },
    };
    return { sink, typed };
  }

  const TARGET = { token: "snap_1:7", snapshotId: "snap_1" };

  it("types the stored value and returns a result with no value in it", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Filled",
      domain: "fill.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const { sink, typed } = await sinkRecorder();
    const result = await fillFromVault(vault, {
      workspaceId,
      url: "https://login.fill.example.test/session",
      itemId: item.id,
      field: "password",
      target: TARGET,
      sink,
    });

    // The value went to the driver and nowhere else, aimed at the observed element.
    expect(typed).toEqual([
      {
        field: "password",
        value: PASSWORD,
        url: "https://login.fill.example.test/session",
        token: "snap_1:7",
        snapshotId: "snap_1",
      },
    ]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(PASSWORD);
    expect(result.length).toBe(PASSWORD.length);
    expect(result.host).toBe("login.fill.example.test");
    expect(result.mayShowOnScreen).toBe(false);
    // A confirmed fill is the only case that may read as success.
    expect(result.effect).toBe("confirmed");
    expect(result.verified).toBe(true);
    expect(result.message).toContain("read it back");
  });

  it("refuses to fill the item's password into a different site", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Never leak",
      domain: "bank.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const { sink, typed } = await sinkRecorder();
    const attempt = fillFromVault(vault, {
      workspaceId,
      url: "https://bank.example.test.evil.test/login",
      itemId: item.id,
      field: "password",
      target: TARGET,
      sink,
    });

    await expect(attempt).rejects.toBeInstanceOf(VaultError);
    await expect(attempt).rejects.toMatchObject({ code: "domain_mismatch" });
    // Nothing reached the driver.
    expect(typed).toEqual([]);
  });

  it("fills contact info with no site recorded, because it is not a credential", async () => {
    const contact = await vault.create({
      workspaceId,
      userId,
      kind: "contact",
      label: "Address",
      values: { name: "Ada Lovelace", email: "ada@example.test" },
    });

    const { sink, typed } = await sinkRecorder();
    const result = await fillFromVault(vault, {
      workspaceId,
      url: "https://any-shop.example.test/checkout",
      itemId: contact.id,
      field: "email",
      target: TARGET,
      sink,
    });
    expect(typed[0]).toMatchObject({ field: "email", value: "ada@example.test" });
    expect(JSON.stringify(result)).not.toContain("ada@example.test");
  });

  it("refuses a fill for a field the item does not hold", async () => {
    const contact = await vault.create({
      workspaceId,
      userId,
      kind: "contact",
      label: "Address",
      values: { name: "Ada Lovelace", email: "ada@example.test" },
    });

    const { sink } = await sinkRecorder();
    await expect(
      fillFromVault(vault, {
        workspaceId,
        url: "https://shop.example.test/checkout",
        itemId: contact.id,
        field: "password",
        target: TARGET,
        sink,
      }),
    ).rejects.toMatchObject({ code: "invalid_field" });
  });

  /**
   * The reason the sink carries an effect at all. A fill that the driver could not
   * confirm must not come back reading like a success, or a model repeats it and the
   * person believes a sign-in happened.
   */
  it("reports an unconfirmed fill as unconfirmed, never as done", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Echoing site",
      domain: "unverified.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const { sink } = await sinkRecorder("unverifiable");
    const result = await fillFromVault(vault, {
      workspaceId,
      url: "https://unverified.example.test/login",
      itemId: item.id,
      field: "password",
      target: TARGET,
      sink,
    });

    expect(result.effect).toBe("unverifiable");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("could not confirm");
    expect(result.message).not.toContain("read it back");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("reports a refused fill as refused, and does not mark the item used", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Stale token",
      domain: "stale.example.test",
      values: { username: "octocat", password: PASSWORD },
    });

    const sink: VaultFillSink = {
      fill: async () => ({ effect: "refused", verified: false, refusalCode: "stale_element_token" }),
    };
    const result = await fillFromVault(vault, {
      workspaceId,
      url: "https://stale.example.test/login",
      itemId: item.id,
      field: "password",
      target: TARGET,
      sink,
    });

    expect(result.effect).toBe("refused");
    expect(result.message).toContain("refused");
    expect(result.message).toContain("stale_element_token");
    expect(result.message).toContain("nothing was typed");

    // Nothing was used, so nothing is recorded as used.
    const after = await vault.get({ workspaceId, itemId: item.id });
    expect(after.lastUsedAt).toBeNull();
  });

  it("reports a no-op as a no-op", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Moved field",
      domain: "moved.example.test",
      values: { username: "octocat", password: PASSWORD },
    });
    const { sink } = await sinkRecorder("suspected_noop");
    const result = await fillFromVault(vault, {
      workspaceId,
      url: "https://moved.example.test/login",
      itemId: item.id,
      field: "password",
      target: TARGET,
      sink,
    });
    expect(result.effect).toBe("suspected_noop");
    expect(result.message).toContain("nothing changed");
  });

  it("marks the item used when a fill succeeds", async () => {
    const item = await vault.create({
      workspaceId,
      userId,
      kind: "login",
      label: "Used",
      domain: "used.example.test",
      values: { username: "octocat", password: PASSWORD },
    });
    const { sink } = await sinkRecorder();
    await fillFromVault(vault, {
      workspaceId,
      url: "https://used.example.test/",
      itemId: item.id,
      field: "username",
      target: TARGET,
      sink,
    });
    const after = await vault.get({ workspaceId, itemId: item.id });
    expect(after.lastUsedAt).not.toBeNull();
  });
});

describe("what a bot may see for a host", () => {
  it("lists only items saved for that exact host, with masked tails", async () => {
    const candidates = await vault.candidatesForDomain({ workspaceId, host: "fill.example.test" });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate.domain).toBe("fill.example.test");
    expect(JSON.stringify(candidates)).not.toContain(PASSWORD);
  });

  it("matches subdomains only when the caller widened the host itself", () => {
    // `candidatesForDomain` is an exact-host lookup on purpose: the bot reads the
    // page's hostname, then the fill re-checks the full URL against the item.
    expect(domainMatches("login.fill.example.test", "fill.example.test")).toBe(true);
  });
});
