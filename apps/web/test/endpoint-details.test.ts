import { loadEnv } from "@terabot/config/load-env";
import {
  createDatabase,
  newId,
  modelCatalog,
  modelEndpoint,
  user as userTable,
  workspace,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { detailsOf, fillEndpointDetails, storedSources } from "../lib/endpoint-config.ts";

/**
 * The gap-only rule, proved against a real database rather than against the pure
 * function alone: an endpoint is written with details a user typed, the
 * auto-population runs, and the values must survive.
 *
 * The pure merge is tested in `@terabot/providers`; what this file adds is the
 * round trip through Postgres — the column types, the null handling, and the
 * provenance list that has to come back out of the row.
 */

loadEnv();

const databaseUrl = process.env.DATABASE_URL;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

const CATALOGUE_PROVIDER = "gaponly-test";
const CATALOGUE_MODEL = "gaponly-model";

async function catalogueFor(db: Db) {
  await db.insert(modelCatalog).values({
    id: newId(),
    provider: CATALOGUE_PROVIDER,
    modelId: CATALOGUE_MODEL,
    name: "Gap-only fixture",
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    modalities: { input: ["text"], output: ["text"] },
    toolSupport: true,
    reasoning: true,
  });
}

/**
 * The base URL's host decides which catalogue provider a fill asks about, so the
 * fixture endpoint points at a host that maps to the fixture provider.
 */
const BASE_URL = "https://gaponly.test/v1";

async function endpointRow(db: Db, values: Partial<typeof modelEndpoint.$inferInsert> = {}) {
  const [owner] = await db
    .insert(userTable)
    .values({
      id: newId(),
      name: "Gap Only",
      email: `gap-${newId()}@terabot.test`,
      emailVerified: false,
    })
    .returning();
  const [space] = await db
    .insert(workspace)
    .values({ id: newId(), ownerId: owner!.id, name: "Gap only" })
    .returning();
  const [row] = await db
    .insert(modelEndpoint)
    .values({
      id: newId(),
      workspaceId: space!.id,
      kind: "openai-chat",
      label: "Fixture",
      baseUrl: BASE_URL,
      modelId: CATALOGUE_MODEL,
      ...values,
    })
    .returning();
  return row!;
}

describe.skipIf(!databaseUrl)("gap-only auto-population in Postgres", () => {
  const handle = createDatabase(databaseUrl ?? "postgres://unused");
  const rollback = new Error("rollback");

  afterAll(() => handle.close());

  async function inRolledBackTransaction(body: (tx: Tx) => Promise<void>) {
    await handle.db
      .transaction(async (tx) => {
        await catalogueFor(tx);
        await body(tx);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  }

  it("keeps a context window the user set, and fills the fields they left empty", async () => {
    await inRolledBackTransaction(async (tx) => {
      const row = await endpointRow(tx, { contextWindow: 32_000 });

      const fill = await fillEndpointDetails(tx, row, CATALOGUE_MODEL);
      expect(fill).not.toBeNull();
      expect(fill!.details.contextWindow).toBe(32_000);
      expect(fill!.details.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
      expect(fill!.details.toolSupport).toBe(true);
      expect(fill!.details.reasoning).toBe(true);
      // The hand-set field is not badged as catalogue-sourced.
      expect(fill!.sources).toEqual(["pricing", "toolSupport", "reasoning"]);
    });
  });

  it("keeps pricing the user set, and fills the rest", async () => {
    await inRolledBackTransaction(async (tx) => {
      const mine = { input: 1, output: 2 };
      const row = await endpointRow(tx, { pricing: mine });

      const fill = await fillEndpointDetails(tx, row, CATALOGUE_MODEL);
      expect(fill!.details.pricing).toEqual(mine);
      expect(fill!.details.contextWindow).toBe(200_000);
      expect(fill!.sources).not.toContain("pricing");
      expect(fill!.sources).toContain("contextWindow");
    });
  });

  it("keeps capabilities the user set, including a deliberate false", async () => {
    await inRolledBackTransaction(async (tx) => {
      const row = await endpointRow(tx, { toolSupport: false, reasoningCapability: false });

      const fill = await fillEndpointDetails(tx, row, CATALOGUE_MODEL);
      expect(fill!.details.toolSupport).toBe(false);
      expect(fill!.details.reasoning).toBe(false);
      expect(fill!.sources).not.toContain("toolSupport");
      expect(fill!.sources).not.toContain("reasoning");
      expect(fill!.details.contextWindow).toBe(200_000);
    });
  });

  it("keeps every hand-set field at once through a write and a re-read", async () => {
    await inRolledBackTransaction(async (tx) => {
      const mine = { contextWindow: 128_000, pricing: { input: 0.5 }, toolSupport: false };
      const row = await endpointRow(tx, {
        contextWindow: mine.contextWindow,
        pricing: mine.pricing,
        toolSupport: mine.toolSupport,
      });

      const fill = await fillEndpointDetails(tx, row, CATALOGUE_MODEL);
      // Write the fill back, as the save path does.
      await tx
        .update(modelEndpoint)
        .set({
          contextWindow: fill!.details.contextWindow,
          pricing: fill!.details.pricing,
          toolSupport: fill!.details.toolSupport,
          reasoningCapability: fill!.details.reasoning,
          autoFilledFields: fill!.sources,
        })
        .where(eq(modelEndpoint.id, row.id));

      const [written] = await tx.select().from(modelEndpoint).where(eq(modelEndpoint.id, row.id));
      expect(detailsOf(written!)).toEqual({
        contextWindow: 128_000,
        pricing: { input: 0.5 },
        toolSupport: false,
        reasoning: true,
      });
      expect(storedSources(written!)).toEqual(["reasoning"]);
    });
  });

  it("changes nothing when the model is not in the catalogue", async () => {
    await inRolledBackTransaction(async (tx) => {
      const row = await endpointRow(tx, { contextWindow: 32_000 });

      expect(await fillEndpointDetails(tx, row, "not-in-the-catalogue")).toBeNull();
      // The row is untouched, so a second read still shows only what was set.
      const [reread] = await tx.select().from(modelEndpoint).where(eq(modelEndpoint.id, row.id));
      expect(detailsOf(reread!)).toEqual({
        contextWindow: 32_000,
        pricing: null,
        toolSupport: null,
        reasoning: null,
      });
    });
  });

  it("keeps a catalogue-filled value badged on a later visit", async () => {
    await inRolledBackTransaction(async (tx) => {
      const row = await endpointRow(tx);
      const first = await fillEndpointDetails(tx, row, CATALOGUE_MODEL);
      await tx
        .update(modelEndpoint)
        .set({
          contextWindow: first!.details.contextWindow,
          pricing: first!.details.pricing,
          toolSupport: first!.details.toolSupport,
          reasoningCapability: first!.details.reasoning,
          autoFilledFields: first!.sources,
        })
        .where(eq(modelEndpoint.id, row.id));

      const [written] = await tx.select().from(modelEndpoint).where(eq(modelEndpoint.id, row.id));
      const second = await fillEndpointDetails(tx, written!, CATALOGUE_MODEL);
      // Nothing new to fill, but the price still came from the catalogue.
      expect(second!.sources).toEqual(["contextWindow", "pricing", "toolSupport", "reasoning"]);
    });
  });
});
