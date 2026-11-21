import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { bot, closeDatabase, database, ensureWorkspace, newId, user } from "@terabot/db";
import type { Database } from "@terabot/db";
import { VaultService, fillFromVault, oneShotSecrets, vaultTools } from "@terabot/vault";
import { auth } from "@terabot/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillSinkForBot, sinkWithoutSurface } from "../src/fill-sink.ts";

/**
 * The two refusals, kept distinguishable.
 *
 * Before the sink was passed, *every* fill answered "this bot has no computer driver
 * attached" — including a bot that had one. That names the wrong cause, and a model
 * reading it concludes the feature is missing rather than that it needs an observation
 * first. These tests pin the distinction so it cannot silently collapse again:
 *
 * - **No box** → no sink at all, and the tool says there is no driver.
 * - **Box, nothing aimable** → a sink that refuses by name, and the tool says to observe
 *   the field first.
 *
 * Neither case types anything, which is the point: a fill with no valid target must not
 * aim at whatever happens to be in front. The "box present" half is tested through
 * `sinkWithoutSurface` rather than by faking a bound computer, because a test that
 * mocked the allocator would only assert that the mock was called.
 */

describe("a run's fill sink", () => {
  let db: Database;
  let workspaceId: string;
  let ownerId: string;
  const email = `sink-${Date.now()}@terabot.test`;

  beforeAll(async () => {
    db = database();
    const signUp = await auth().api.signUpEmail({
      body: { email, password: "sink-test-password", name: "Sink Test" },
      returnHeaders: true,
    });
    ownerId = signUp.response.user.id;
    workspaceId = (await ensureWorkspace(ownerId, "Sink Test")).id;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.delete(user).where(eq(user.email, email));
    await closeDatabase();
  });

  /** A bot on no computer at all, which is the "no driver" case. */
  async function botWithoutBox(): Promise<string> {
    const id = newId();
    await db.insert(bot).values({
      id,
      workspaceId,
      name: `No Box ${id.slice(0, 6)}`,
      avatar: { shape: "circle", color: "slate" },
      accentColor: "#64748b",
      instructions: "No computer.",
    });
    return id;
  }

  function contextFor(botId: string) {
    return {
      workspaceId,
      botId,
      conversationId: newId(),
      runId: newId(),
      signal: new AbortController().signal,
      emit: async () => 1,
    };
  }

  const FILL_ARGS = {
    url: "https://shop.example.test/login",
    itemId: "item-1",
    field: "password",
    token: "snap:1",
    snapshotId: "snap",
  };

  function fillTool(sink?: Awaited<ReturnType<typeof fillSinkForBot>>) {
    return vaultTools({
      db,
      vault: new VaultService(db),
      oneShot: oneShotSecrets(),
      ...(sink ? { sink } : {}),
    }).find((tool) => tool.schema.name === "vault_fill")!;
  }

  it("is absent for a bot with no computer, and the tool says there is no driver", async () => {
    const botId = await botWithoutBox();
    expect(await fillSinkForBot(botId)).toBeUndefined();

    const outcome = await fillTool().handler(FILL_ARGS, contextFor(botId));
    expect(outcome.result).toContain("no computer driver attached");
    // The message must not send the model looking for an observation it cannot make.
    expect(outcome.result).not.toContain("observe");
  });

  /**
   * The distinguishing case. A sink exists, so the tool must stop claiming the driver is
   * missing and instead ask for the thing that is actually missing: a target. The item is
   * real, because the refusal has to come from the sink and not from a lookup miss.
   */
  it("refuses with an aimable instruction when there is a box but no surface", async () => {
    const botId = await botWithoutBox();
    const vault = new VaultService(db);
    const item = await vault.create({
      workspaceId,
      userId: ownerId,
      kind: "login",
      label: "Sink shop",
      domain: "shop.example.test",
      values: { username: "fake-sink-user", password: "fake-sink-pass-1" },
    });

    const response = await fillFromVault(vault, {
      workspaceId,
      url: FILL_ARGS.url,
      itemId: item.id,
      field: "password",
      target: { token: FILL_ARGS.token, snapshotId: FILL_ARGS.snapshotId },
      sink: sinkWithoutSurface(),
    });

    // The refusal names the code and asks for an observation — the actionable half.
    expect(response.effect).toBe("refused");
    expect(response.message).toContain("observe");
    expect(response.message).not.toContain("no computer driver attached");
    expect(response.message).not.toContain("fake-sink-pass-1");

    // And through the tool, what the model reads is the same sentence.
    const outcome = await fillTool(sinkWithoutSurface()).handler(
      { ...FILL_ARGS, itemId: item.id },
      { ...contextFor(botId) },
    );
    expect(outcome.result).toContain("observe");
  });

  it("reports the refusal as a code rather than as a fill that failed silently", async () => {
    const outcome = await sinkWithoutSurface().fill({
      url: "https://shop.example.test/login",
      target: { token: "snap:1", snapshotId: "snap" },
      field: "password",
      value: "fake-clhhd-isnq-9tqs-hbp-g-tnrh-vwupnzsv",
    });
    expect(outcome.effect).toBe("refused");
    expect(outcome.refusalCode).toBe("no_fill_surface");
    expect(outcome.verified).toBe(false);
    // And the refusal must not echo the value it was handed.
    expect(JSON.stringify(outcome)).not.toContain("fake-clhhd");
  });
});
