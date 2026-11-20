import { and, eq } from "drizzle-orm";
import { database } from "./client.ts";
import { newId } from "./ids.ts";
import { botSection, workspace } from "./schema.ts";

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

  if (created) return created;
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
