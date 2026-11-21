import { loadEnv } from "@terabot/config/load-env";
import { createDatabase, modelEndpoint, newId, user as userTable, workspace } from "@terabot/db";
import { BUILTIN_PROVIDERS, builtinProvider } from "@terabot/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A built-in's base URL never reaches the client.
 *
 * The product promise is that a user picks a provider and pastes a key: the URL is
 * fixed server-side, so it is not shown, not editable, and not shipped. `EndpointView`
 * expresses that with `baseUrl: builtin ? null : row.baseUrl`, which is one ternary
 * away from being undone — and undoing it leaks a URL into the props of every page
 * that renders Settings, where it is visible in the RSC payload and in devtools.
 *
 * So this asserts against what `loadShellData` actually returns, which is the value
 * both `app/page.tsx` and `app/[botId]/page.tsx` hand to client components. It does
 * not grep rendered HTML: a marketing page change could make that vacuous, and a
 * string search cannot tell a built-in's URL from a custom endpoint's, which is
 * legitimately present.
 *
 * A failure here means the boundary moved, not that the assertion is stale. Read the
 * diff of `apps/web/lib/data.ts` before changing this file.
 */

loadEnv();

const databaseUrl = process.env.DATABASE_URL;
const ids = { userId: newId(), workspaceId: newId() };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../lib/session.ts", () => ({
  requireUser: async () => ({ id: ids.userId, name: "Leak Test", email: "leak@terabot.test" }),
  currentWorkspace: async () => ({ id: ids.workspaceId, ownerId: ids.userId, name: "Leak test" }),
}));

const CUSTOM_URL = "https://my-own-gateway.example/v1";

describe.skipIf(!databaseUrl)("a built-in's base URL stays on the server", () => {
  const handle = createDatabase(databaseUrl ?? "postgres://unused");
  let loadShellData: typeof import("../lib/data.ts").loadShellData;

  beforeAll(async () => {
    await handle.db
      .insert(userTable)
      .values({ id: ids.userId, name: "Leak Test", email: "leak@terabot.test", emailVerified: false })
      .onConflictDoNothing();
    await handle.db
      .insert(workspace)
      .values({ id: ids.workspaceId, ownerId: ids.userId, name: "Leak test" })
      .onConflictDoNothing();

    // Every built-in, plus a custom endpoint as the control: the control has to keep
    // its URL, or a change that nulls baseUrl unconditionally would pass this file.
    let position = 0;
    for (const builtin of BUILTIN_PROVIDERS) {
      await handle.db
        .insert(modelEndpoint)
        .values({
          id: newId(),
          workspaceId: ids.workspaceId,
          label: builtin.name,
          kind: builtin.kind,
          baseUrl: builtin.baseUrl,
          builtinId: builtin.id,
          modelId: `${builtin.id}-default-model`,
          createdAt: new Date(Date.now() + position++),
        })
        .onConflictDoNothing();
    }
    await handle.db
      .insert(modelEndpoint)
      .values({
        id: newId(),
        workspaceId: ids.workspaceId,
        label: "My gateway",
        kind: "openai-chat",
        baseUrl: CUSTOM_URL,
        builtinId: null,
        modelId: "my-own-model",
        createdAt: new Date(Date.now() + position),
      })
      .onConflictDoNothing();

    const data = await import("../lib/data.ts");
    loadShellData = data.loadShellData;
  });

  afterAll(async () => {
    await handle.db.delete(modelEndpoint).where(eq(modelEndpoint.workspaceId, ids.workspaceId));
    await handle.db.delete(workspace).where(eq(workspace.id, ids.workspaceId));
    await handle.db.delete(userTable).where(eq(userTable.id, ids.userId));
    await handle.close();
  });

  async function shell() {
    // The exact payload `app/page.tsx` passes to client components.
    return loadShellData({
      user: { id: ids.userId, name: "Leak Test", email: "leak@terabot.test", role: "member" },
      workspaceId: ids.workspaceId,
      apiUrl: "http://localhost:4000",
    });
  }

  it("the premise: every built-in row is stored and read back as a built-in", async () => {
    // Without this, a mapper that resolved no built-ins would make the assertions
    // below pass while proving nothing — the vacuous-test trap.
    const data = await shell();
    expect(data.endpoints).toHaveLength(BUILTIN_PROVIDERS.length + 1);
    for (const builtin of BUILTIN_PROVIDERS) {
      const view = data.endpoints.find((entry) => entry.builtinId === builtin.id);
      expect(view, `${builtin.id} is missing from the shell data`).toBeDefined();
      expect(view!.builtinName).toBe(builtin.name);
    }
  });

  it("every built-in endpoint the client receives has a null baseUrl", async () => {
    const data = await shell();
    const builtins = data.endpoints.filter((entry) => entry.builtinId !== null);
    expect(builtins).toHaveLength(BUILTIN_PROVIDERS.length);
    for (const view of builtins) {
      expect(view.baseUrl, `${view.builtinName} shipped its base URL to the client`).toBeNull();
    }
  });

  it("no built-in's URL appears anywhere in the serialised payload", async () => {
    // The prop-level check above is the contract; this one catches a URL that reaches
    // the client through a field nobody thought of, such as `providerHint`. It is
    // deliberately run over the whole payload, because any new field is a new way out.
    const payload = JSON.stringify(await shell());
    for (const builtin of BUILTIN_PROVIDERS) {
      expect(payload, `${builtin.id}'s ${builtin.baseUrl} reached the client`).not.toContain(
        builtin.baseUrl,
      );
    }
  });

  it("a custom endpoint still shows its own URL, so the check is not vacuous", async () => {
    // If a change nulled every baseUrl, the tests above would still pass. This is what
    // makes them mean "built-in" rather than "any URL".
    const data = await shell();
    const custom = data.endpoints.find((entry) => entry.builtinId === null);
    expect(custom, "the control endpoint is missing").toBeDefined();
    expect(custom!.baseUrl).toBe(CUSTOM_URL);
    expect(JSON.stringify(data)).toContain(CUSTOM_URL);
  });

  it("a built-in is identified by name, so Settings can still label the row", async () => {
    // The reason nulling the URL is safe: the client has no need for it. If this ever
    // fails, the mapper has stopped resolving built-ins and the null above may be an
    // accident rather than a guarantee.
    const data = await shell();
    const custom = data.endpoints.find((entry) => entry.builtinId === null);
    expect(custom!.builtinName).toBeNull();
    const openrouter = data.endpoints.find((entry) => entry.builtinId === "openrouter");
    const provider = builtinProvider("openrouter");
    expect(openrouter!.builtinName).toBe(provider!.name);
  });
});
