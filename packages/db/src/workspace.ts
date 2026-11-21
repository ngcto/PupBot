import { serverEnv } from "@terabot/config";
import { and, eq } from "drizzle-orm";
import { database } from "./client.ts";
import { newId } from "./ids.ts";
import { botSection, modelCatalog, modelEndpoint, workspace } from "./schema.ts";

/**
 * In development a fresh workspace gets the local stub endpoint, so a new user
 * can chat immediately with no key. Production workspaces start empty and the
 * user adds an endpoint in Settings › Models.
 */
async function seedStubEndpoint(workspaceId: string): Promise<void> {
  const env = serverEnv();
  if (!env.STUB_PROVIDER || env.NODE_ENV === "production") return;

  const db = database();
  const baseUrl = `${env.API_URL.replace(/\/+$/, "")}/dev/stub/v1`;

  const [catalog] = await db
    .insert(modelCatalog)
    .values({
      id: newId(),
      provider: "terabot",
      modelId: "tera-stub",
      name: "Tera stub (dev)",
      contextWindow: 100_000,
      maxOutput: 8_192,
      pricing: { input: 0, output: 0 },
      modalities: { input: ["text"], output: ["text"] },
      toolSupport: false,
      reasoning: false,
    })
    .onConflictDoUpdate({
      target: [modelCatalog.provider, modelCatalog.modelId],
      set: { name: "Tera stub (dev)" },
    })
    .returning();

  await db.insert(modelEndpoint).values({
    id: newId(),
    workspaceId,
    kind: "openai-chat",
    label: "Local stub endpoint",
    baseUrl,
    modelId: "tera-stub",
    modelCatalogId: catalog?.id ?? null,
    catalogMatch: "matched",
    contextWindow: 100_000,
  });
}

/**
 * Every user gets exactly one default workspace. Called after sign-up and on
 * every session resolve, so an interrupted signup still ends up with one.
 */
export async function ensureWorkspace(userId: string, userName = "You") {
  const db = database();
  const existing = await db.select().from(workspace).where(eq(workspace.ownerId, userId)).limit(1);
  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(workspace)
    .values({ id: newId(), ownerId: userId, name: `${userName}'s workspace` })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await seedStubEndpoint(created.id).catch((error) => {
      console.warn("[workspace] could not seed the stub endpoint:", error);
    });
    return created;
  }
  const raced = await db.select().from(workspace).where(eq(workspace.ownerId, userId)).limit(1);
  if (!raced[0]) throw new Error("workspace could not be created");
  return raced[0];
}

export async function findWorkspace(userId: string) {
  const db = database();
  const rows = await db.select().from(workspace).where(eq(workspace.ownerId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function sectionsFor(workspaceId: string) {
  return database()
    .select()
    .from(botSection)
    .where(and(eq(botSection.workspaceId, workspaceId)))
    .orderBy(botSection.position);
}
