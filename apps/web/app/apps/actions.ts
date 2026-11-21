"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { database, bot as botTable } from "@pupbot/db";
import {
  describeError,
  disconnectConnection,
  listApps,
  refreshConnections,
  setBotApp,
  startConnection,
} from "../../lib/apps.ts";
import type { AppList, ConnectedApp } from "../../lib/types.ts";
import { currentWorkspace, requireUser } from "../../lib/session.ts";

async function context() {
  const user = await requireUser();
  const workspace = await currentWorkspace(user);
  return { user, workspace };
}

async function ownedBot(workspaceId: string, botId: string): Promise<void> {
  const rows = await database()
    .select({ id: botTable.id })
    .from(botTable)
    .where(and(eq(botTable.id, botId), eq(botTable.workspaceId, workspaceId)))
    .limit(1);
  if (!rows[0]) throw new Error("bot not found in this workspace");
}

export interface ConnectResult {
  error: string | null;
  redirectUrl: string | null;
}

/**
 * Starts the Composio hosted flow. The redirect URL is returned to the browser,
 * which opens it in a new window, so the marketplace stays where it was while the
 * user authorizes the app elsewhere.
 */
export async function connectApp(toolkit: string, origin: string): Promise<ConnectResult> {
  const { user, workspace } = await context();
  try {
    const callbackUrl = `${origin.replace(/\/+$/, "")}/apps/callback`;
    const { redirectUrl } = await startConnection({
      userId: user.id,
      workspaceId: workspace.id,
      toolkit,
      callbackUrl,
    });
    revalidatePath("/apps");
    return { error: null, redirectUrl };
  } catch (error) {
    return { error: describeError(error), redirectUrl: null };
  }
}

/** This user's connections, read fresh: a settings panel must not show stale ones. */
export async function loadConnections(): Promise<ConnectedApp[]> {
  const { user } = await context();
  return refreshConnections(user.id);
}

/** What a finished authorization (or an abandoned one) looks like now. */
export async function pollApps(): Promise<{ connections: ConnectedApp[]; error: string | null }> {
  const { user } = await context();
  try {
    return { connections: await refreshConnections(user.id), error: null };
  } catch (error) {
    return { connections: [], error: describeError(error) };
  }
}

export async function loadApps(input: {
  search?: string;
  category?: string;
  cursor?: string;
}): Promise<AppList> {
  const { user } = await context();
  return listApps({ userId: user.id, ...input });
}

export async function disconnectApp(connectionId: string): Promise<{ error: string | null }> {
  const { user } = await context();
  try {
    await disconnectConnection({ userId: user.id, connectionId });
    revalidatePath("/", "layout");
    return { error: null };
  } catch (error) {
    return { error: describeError(error) };
  }
}

export async function toggleBotApp(
  botId: string,
  connectionId: string,
  enabled: boolean,
): Promise<{ error: string | null }> {
  const { workspace } = await context();
  try {
    await ownedBot(workspace.id, botId);
    await setBotApp({ workspaceId: workspace.id, botId, connectionId, enabled });
    revalidatePath("/", "layout");
    return { error: null };
  } catch (error) {
    return { error: describeError(error) };
  }
}
