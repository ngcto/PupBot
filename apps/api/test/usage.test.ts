import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { executeRun } from "@terabot/agent";
import {
  bot,
  closeDatabase,
  conversation,
  database,
  message,
  modelCatalog,
  modelEndpoint,
  newId,
  run,
  usageEvent,
  user,
  workspace,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import type { ModelGateway } from "@terabot/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function pricedGateway(): ModelGateway {
  return {
    async *stream() {
      yield { type: "text_delta" as const, text: "priced reply" };
      yield {
        type: "usage" as const,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
      };
    },
  };
}

describe("usage events are priced from the catalogue", () => {
  let db: Database;
  const ownerId = `usage-${Date.now()}`;
  let workspaceId = "";
  let catalogId = "";
  let pricedEndpointId = "";
  let unpricedEndpointId = "";
  const pricedModel = `priced-model-${ownerId}`;
  const unpricedModel = `mystery-model-${ownerId}`;

  beforeAll(async () => {
    db = database();
    await db.insert(user).values({
      id: ownerId,
      name: "Usage Test",
      email: `${ownerId}@terabot.dev`,
      emailVerified: true,
    });
    workspaceId = newId();
    await db.insert(workspace).values({ id: workspaceId, ownerId, name: "Usage" });

    catalogId = newId();
    await db.insert(modelCatalog).values({
      id: catalogId,
      provider: "openai",
      modelId: pricedModel,
      name: "Priced Model",
      contextWindow: 128000,
      pricing: { input: 3, output: 15, cacheRead: 0.3 },
      toolSupport: true,
    });

    pricedEndpointId = newId();
    await db.insert(modelEndpoint).values({
      id: pricedEndpointId,
      workspaceId,
      kind: "openai-chat",
      label: "priced",
      baseUrl: "https://api.openai.com/v1",
      modelId: pricedModel,
      catalogMatch: "matched",
      modelCatalogId: catalogId,
    });

    unpricedEndpointId = newId();
    await db.insert(modelEndpoint).values({
      id: unpricedEndpointId,
      workspaceId,
      kind: "openai-chat",
      label: "unpriced",
      baseUrl: "https://example.test/v1",
      modelId: unpricedModel,
      catalogMatch: "unmatched",
    });
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.delete(modelCatalog).where(eq(modelCatalog.id, catalogId));
      await db.delete(user).where(eq(user.id, ownerId));
    }
    await closeDatabase();
  });

  async function runOnce(endpointId: string, modelId: string): Promise<string> {
    const botId = newId();
    const conversationId = newId();
    const runId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId,
      name: "Usage Tera",
      avatar: { shape: "tera", color: "amber" },
      accentColor: "#f69412",
      instructions: "",
      modelEndpointId: endpointId,
      modelId,
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Usage" });
    await db.insert(message).values({
      id: newId(),
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      status: "complete",
    });
    await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });

    const outcome = await executeRun({ db, gateway: pricedGateway(), runId, abortPollMs: 20 });
    expect(outcome.status).toBe("done");
    return runId;
  }

  it("writes tokens and USD cost for a model the catalogue prices", async () => {
    const runId = await runOnce(pricedEndpointId, pricedModel);

    const [usage] = await db.select().from(usageEvent).where(eq(usageEvent.runId, runId));
    expect(usage).toMatchObject({
      model: pricedModel,
      inputTokens: 1200,
      outputTokens: 500,
    });
    // 1000 input × $3/M + 200 cache reads × $0.3/M + 500 output × $15/M
    expect(Number(usage?.cost)).toBeCloseTo(0.01056, 6);

    const [finished] = await db.select().from(run).where(eq(run.id, runId));
    expect(Number(finished?.cost)).toBeCloseTo(0.01056, 6);
  }, 30_000);

  it("leaves the cost null rather than zero when no catalogue price matches", async () => {
    const runId = await runOnce(unpricedEndpointId, unpricedModel);

    const [usage] = await db.select().from(usageEvent).where(eq(usageEvent.runId, runId));
    expect(usage?.cost).toBeNull();
    expect(usage?.inputTokens).toBe(1200);

    const [finished] = await db.select().from(run).where(eq(run.id, runId));
    expect(finished?.cost).toBeNull();
  }, 30_000);
});
