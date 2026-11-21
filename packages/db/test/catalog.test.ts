import { loadEnv } from "@terabot/config/load-env";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  CatalogSchemaError,
  catalogRowsFrom,
  findCatalogMatch,
  syncModelCatalog,
} from "../src/catalog.ts";
import { createDatabase } from "../src/client.ts";
import { modelCatalog } from "../src/schema.ts";

const fixture: Record<string, any> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/models-dev.json", import.meta.url)), "utf8"),
);

loadEnv();

describe("catalogRowsFrom", () => {
  const rows = catalogRowsFrom(fixture);
  const row = (provider: string, modelId: string) => rows.find((r) => r.provider === provider && r.modelId === modelId)!;

  it("maps every model of every provider", () => {
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(["anthropic", "agentrouter"]));
  });

  it("keeps pricing per 1M tokens as models.dev states it", () => {
    expect(row("anthropic", "claude-sonnet-4-5").pricing).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(row("anthropic", "claude-opus-4-8").pricing).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it("stores null pricing when the provider publishes no cost", () => {
    expect(row("agentrouter", "claude-opus-4-8").pricing).toBeNull();
  });

  it("maps limits, modalities, tool support and reasoning", () => {
    expect(row("agentrouter", "gpt-5.6-sol")).toMatchObject({
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      toolSupport: true,
      reasoning: true,
    });
  });

  it("keeps the full provider and model objects in raw", () => {
    const raw = row("anthropic", "claude-opus-4-8").raw as any;
    expect(raw.provider).toMatchObject({ id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic" });
    expect(raw.provider.models).toBeUndefined();
    expect(raw.model).toEqual(fixture.anthropic.models["claude-opus-4-8"]);
  });

  it("defaults absent optional flags and treats a zero limit as unknown", () => {
    const [only] = catalogRowsFrom({
      acme: {
        id: "acme",
        name: "Acme",
        models: {
          draw: {
            id: "draw",
            name: "Draw",
            modalities: { input: ["text"], output: ["image"] },
            limit: { context: 0, output: 0 },
          },
        },
      },
    });
    expect(only).toMatchObject({
      contextWindow: null,
      maxOutput: null,
      pricing: null,
      toolSupport: false,
      reasoning: false,
    });
  });

  it("fails loudly and readably when the payload drifts", () => {
    const drifted = structuredClone(fixture);
    delete drifted.anthropic.models["claude-opus-4-8"].limit.context;
    drifted.agentrouter.name = 7;
    expect(() => catalogRowsFrom(drifted)).toThrow(CatalogSchemaError);
    expect(() => catalogRowsFrom(drifted)).toThrow(/anthropic\.models\.claude-opus-4-8\.limit\.context/);
    expect(() => catalogRowsFrom(drifted)).toThrow(/agentrouter\.name/);
    expect(() => catalogRowsFrom([])).toThrow(CatalogSchemaError);
    expect(() => catalogRowsFrom({})).toThrow(/no providers/);
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("model catalogue in Postgres", () => {
  const handle = createDatabase(databaseUrl ?? "postgres://unused");
  const fetchImpl = (async () => Response.json(fixture)) as typeof fetch;
  const rollback = new Error("rollback");

  afterAll(() => handle.close());

  /** Runs inside a transaction that is always rolled back, so no row outlives the test. */
  async function inRolledBackTransaction(body: (tx: Parameters<Parameters<typeof handle.db.transaction>[0]>[0]) => Promise<void>) {
    await handle.db
      .transaction(async (tx) => {
        await tx.delete(modelCatalog);
        await body(tx);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  }

  it("upserts idempotently and matches by provider+model or bare model id", async () => {
    await inRolledBackTransaction(async (tx) => {
      const count = async () => (await tx.select({ n: sql<number>`count(*)::int` }).from(modelCatalog))[0]!.n;

      expect(await syncModelCatalog(tx, { fetchImpl, url: "https://models.test/api.json" })).toEqual({
        total: 4,
        upserted: 4,
        providers: 2,
      });
      const first = await tx.select().from(modelCatalog);
      expect(first).toHaveLength(4);

      expect(await syncModelCatalog(tx, { fetchImpl, url: "https://models.test/api.json" })).toEqual({
        total: 4,
        upserted: 4,
        providers: 2,
      });
      expect(await count()).toBe(4);
      const second = await tx.select().from(modelCatalog);
      expect(new Set(second.map((r) => r.id))).toEqual(new Set(first.map((r) => r.id)));

      const exact = await findCatalogMatch(tx, { modelId: "claude-sonnet-4-5", providerHint: "anthropic" });
      expect(exact.match).toBe("matched");
      expect(exact.row).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5", contextWindow: 200_000 });
      expect(exact.row?.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

      const bare = await findCatalogMatch(tx, { modelId: "gpt-5.6-sol" });
      expect(bare).toMatchObject({ match: "matched", row: { provider: "agentrouter" } });

      const shared = await findCatalogMatch(tx, { modelId: "claude-opus-4-8" });
      expect(shared).toMatchObject({ match: "matched", row: { provider: "anthropic" } });

      const hinted = await findCatalogMatch(tx, { modelId: "claude-opus-4-8", providerHint: "agentrouter-eu" });
      expect(hinted).toMatchObject({ match: "matched", row: { provider: "agentrouter" } });

      const missing = await findCatalogMatch(tx, { modelId: "does-not-exist", providerHint: "anthropic" });
      expect(missing).toEqual({ row: null, match: "unmatched" });
      expect(await findCatalogMatch(tx, { modelId: "does-not-exist" })).toEqual({ row: null, match: "unmatched" });
    });
  });

  it("updates changed fields on re-sync", async () => {
    await inRolledBackTransaction(async (tx) => {
      await syncModelCatalog(tx, { fetchImpl, url: "https://models.test/api.json" });
      const changed = structuredClone(fixture);
      changed.anthropic.models["claude-sonnet-4-5"].cost.input = 4;
      changed.anthropic.models["claude-sonnet-4-5"].name = "Sonnet 4.5 renamed";
      await syncModelCatalog(tx, { fetchImpl: (async () => Response.json(changed)) as typeof fetch, url: "https://models.test/api.json" });

      const { row } = await findCatalogMatch(tx, { modelId: "claude-sonnet-4-5", providerHint: "anthropic" });
      expect(row?.name).toBe("Sonnet 4.5 renamed");
      expect(row?.pricing?.input).toBe(4);
    });
  });

  it("rejects a failed fetch without touching the table", async () => {
    await inRolledBackTransaction(async (tx) => {
      const failing = (async () => new Response("nope", { status: 503 })) as typeof fetch;
      await expect(syncModelCatalog(tx, { fetchImpl: failing, url: "https://models.test/api.json" })).rejects.toThrow(/503/);
    });
  });
});
