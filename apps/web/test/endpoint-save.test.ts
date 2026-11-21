import { loadEnv } from "@terabot/config/load-env";
import { createDatabase, modelEndpoint, newId, user as userTable, workspace } from "@terabot/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The save actions, called for real.
 *
 * The earlier tests in this folder exercised the merge helper and inserted the
 * result themselves, so they passed while `addModelEndpoint` dropped a value the
 * user had typed — the destruction happened at the assignment, not in the helper.
 * These go through the action so a regression there fails here.
 *
 * Only the session is stubbed: `requireUser` needs a request context that a unit
 * test does not have. Everything else — the catalogue lookup, the gap-only fill,
 * the write — is the production path against a real database.
 */

loadEnv();

const databaseUrl = process.env.DATABASE_URL;
const ids = { userId: newId(), workspaceId: newId() };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../lib/session.ts", () => ({
  requireUser: async () => ({ id: ids.userId, name: "Save Test", email: "save@terabot.test" }),
  currentWorkspace: async () => ({ id: ids.workspaceId, ownerId: ids.userId, name: "Save test" }),
}));

const BASE_URL = "https://uncatalogued.test/v1";
/**
 * A model id no catalogue will ever list. Without it the default model resolves to
 * a real catalogue entry, the unmatched branch these tests exist for never runs,
 * and every assertion below passes vacuously.
 */
const UNCATALOGUED = "definitely-not-a-real-model-id";

describe.skipIf(!databaseUrl)("saving an endpoint through the action", () => {
  const handle = createDatabase(databaseUrl ?? "postgres://unused");
  let addModelEndpoint: typeof import("../app/actions.ts").addModelEndpoint;
  let updateModelEndpointProvider: typeof import("../app/actions.ts").updateModelEndpointProvider;

  beforeAll(async () => {
    await handle.db
      .insert(userTable)
      .values({ id: ids.userId, name: "Save Test", email: "save@terabot.test", emailVerified: false })
      .onConflictDoNothing();
    await handle.db
      .insert(workspace)
      .values({ id: ids.workspaceId, ownerId: ids.userId, name: "Save test" })
      .onConflictDoNothing();
    // Imported after the mocks so the action picks the stubbed session up.
    const actions = await import("../app/actions.ts");
    addModelEndpoint = actions.addModelEndpoint;
    updateModelEndpointProvider = actions.updateModelEndpointProvider;
  });

  afterAll(async () => {
    await handle.db.delete(modelEndpoint).where(eq(modelEndpoint.workspaceId, ids.workspaceId));
    await handle.db.delete(workspace).where(eq(workspace.id, ids.workspaceId));
    await handle.db.delete(userTable).where(eq(userTable.id, ids.userId));
    await handle.close();
  });

  async function row(endpointId: string) {
    const [found] = await handle.db
      .select()
      .from(modelEndpoint)
      .where(eq(modelEndpoint.id, endpointId));
    return found!;
  }

  it("uses a model the catalogue really does not have", async () => {
    // The premise every other test here rests on.
    const { findCatalogMatch } = await import("@terabot/db");
    const match = await findCatalogMatch(handle.db, { modelId: UNCATALOGUED });
    expect(match.match).toBe("unmatched");
  });

  it("stores the window typed on the add form", async () => {
    const result = await addModelEndpoint({
      label: "Uncatalogued",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      modelId: UNCATALOGUED,
      contextWindow: 32_000,
    });
    const saved = await row(result.endpointId);
    expect(saved.contextWindow).toBe(32_000);
    // It is the user's number, so it is not badged as catalogue-sourced.
    expect(saved.autoFilledFields ?? []).not.toContain("contextWindow");
  });

  it("keeps a typed window through a label-only save", async () => {
    const result = await addModelEndpoint({
      label: "Keep my window",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      modelId: UNCATALOGUED,
      contextWindow: 32_000,
    });
    await updateModelEndpointProvider({
      endpointId: result.endpointId,
      label: "Renamed",
      kind: "openai-chat",
      baseUrl: BASE_URL,
    });
    const saved = await row(result.endpointId);
    expect(saved.label).toBe("Renamed");
    expect(saved.contextWindow).toBe(32_000);
  });

  it("keeps stored pricing and capabilities on an unmatched label-only save", async () => {
    const result = await addModelEndpoint({
      label: "Has metadata",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      modelId: UNCATALOGUED,
    });
    // What an earlier save or a migration left on the row.
    await handle.db
      .update(modelEndpoint)
      .set({
        pricing: { input: 1, output: 2 },
        toolSupport: false,
        reasoningCapability: false,
      })
      .where(eq(modelEndpoint.id, result.endpointId));

    await updateModelEndpointProvider({
      endpointId: result.endpointId,
      label: "Still mine",
      kind: "openai-chat",
      baseUrl: BASE_URL,
    });
    const saved = await row(result.endpointId);
    expect(saved.pricing).toEqual({ input: 1, output: 2 });
    expect(saved.toolSupport).toBe(false);
    expect(saved.reasoningCapability).toBe(false);
  });

  it("keeps a window typed during a retarget to an uncatalogued model", async () => {
    const result = await addModelEndpoint({
      label: "Retarget",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      modelId: UNCATALOGUED,
    });
    // A different host and a typed window: neither the fill nor the old row has
    // an answer, so only the typed value can survive.
    await updateModelEndpointProvider({
      endpointId: result.endpointId,
      label: "Retargeted",
      kind: "openai-chat",
      baseUrl: "https://other-uncatalogued.test/v1",
      contextWindow: 64_000,
    });
    expect((await row(result.endpointId)).contextWindow).toBe(64_000);
  });

  it("clears a typed window when the form sends an explicit null", async () => {
    const result = await addModelEndpoint({
      label: "Clear me",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      modelId: UNCATALOGUED,
      contextWindow: 32_000,
    });
    await updateModelEndpointProvider({
      endpointId: result.endpointId,
      label: "Cleared",
      kind: "openai-chat",
      baseUrl: BASE_URL,
      contextWindow: null,
    });
    expect((await row(result.endpointId)).contextWindow).toBeNull();
  });
});
