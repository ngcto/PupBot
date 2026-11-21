import { serverEnv } from "@terabot/config";
import { ComposioClient, ComposioError, type AuthConfig } from "@terabot/composio";
import { appConnection, bot as botTable, botApp, database, newId } from "@terabot/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppCard, AppList, AppState, ConnectedApp } from "./types.ts";

/**
 * The server side of the marketplace: the only place the Composio project key is
 * read, and the only place a connected account is written to our database.
 *
 * A connection we hold is a reference. The OAuth tokens (or the user's API key)
 * live inside Composio and never pass through this process, so nothing here reads,
 * logs or stores a credential.
 */

export type { AppCard, AppList, AppState, ConnectedApp };

export function composioClient(): ComposioClient | null {
  const env = serverEnv();
  if (!env.COMPOSIO_PROJECT_API_KEY) return null;
  return new ComposioClient({
    apiKey: env.COMPOSIO_PROJECT_API_KEY,
    baseUrl: env.COMPOSIO_BASE_URL,
  });
}

export function requireComposio(): ComposioClient {
  const client = composioClient();
  if (!client) {
    throw new ComposioError(
      "not_configured",
      "The app marketplace is not configured on this server: COMPOSIO_PROJECT_API_KEY is missing.",
    );
  }
  return client;
}

/**
 * A message already written for a person. `describeError` passes it through rather
 * than replacing it, so a database or provider failure never reaches the UI as a raw
 * query string.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

function stateFromStatus(status: string): AppState {
  if (status === "active") return "connected";
  if (status === "pending") return "pending";
  return "failed";
}

/** Rows for this user only. A user never sees, or touches, another user's connections. */
async function connectionsFor(userId: string) {
  return database()
    .select()
    .from(appConnection)
    .where(and(eq(appConnection.userId, userId), inArray(appConnection.status, ["pending", "active", "error"])))
    .orderBy(desc(appConnection.createdAt));
}

export async function listConnectionsFor(userId: string): Promise<ConnectedApp[]> {
  const rows = await connectionsFor(userId);
  if (rows.length === 0) return [];

  const enabled = await database()
    .select({ connectionId: botApp.connectionId })
    .from(botApp)
    .where(
      inArray(
        botApp.connectionId,
        rows.map((row) => row.id),
      ),
    );

  const enabledIds = new Set(enabled.map((entry) => entry.connectionId));
  return rows.map((row) => ({
    id: row.id,
    toolkit: row.toolkit,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    botEnabled: enabledIds.has(row.id),
  }));
}

/**
 * Reads Composio for every pending connection of this user and writes back what it
 * says. Returning the fresh rows lets the UI show "waiting for approval" until the
 * user is done on Composio's page, then flip to connected without a reload.
 */
export async function refreshConnections(userId: string): Promise<ConnectedApp[]> {
  const client = composioClient();
  const pending = await database()
    .select()
    .from(appConnection)
    .where(and(eq(appConnection.userId, userId), eq(appConnection.status, "pending")));

  if (client && pending.length > 0) {
    await Promise.all(
      pending.map(async (row) => {
        const remote = await client.getConnection(row.composioAccountId).catch(() => null);
        if (!remote) {
          await database()
            .update(appConnection)
            .set({
              status: "error",
              lastError: "Composio no longer knows this connection.",
              lastCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(appConnection.id, row.id));
          return;
        }
        const status =
          remote.state === "active" ? "active" : remote.state === "pending" ? "pending" : "error";
        await database()
          .update(appConnection)
          .set({
            status,
            statusDetail: remote.rawStatus,
            lastError:
              status === "error" ? `Composio reports ${remote.rawStatus || "an unknown state"}.` : null,
            lastCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(appConnection.id, row.id));
      }),
    );
  }

  return listConnectionsFor(userId);
}

/**
 * One page of the catalogue with this user's connection state folded in. The auth
 * configs come from the project, so an app that is configured but not connected
 * reads as such, and an app this beta cannot connect says why before a click.
 */
export async function listApps(input: {
  userId: string;
  search?: string;
  category?: string;
  cursor?: string;
}): Promise<AppList> {
  const client = composioClient();
  if (!client) {
    return { items: [], nextCursor: null, categories: [], configured: false, error: null };
  }

  try {
    const [page, configs, connections] = await Promise.all([
      client.listToolkits({ search: input.search, category: input.category, cursor: input.cursor, limit: 60 }),
      client.listAuthConfigs().catch(() => [] as AuthConfig[]),
      connectionsFor(input.userId),
    ]);

    const byToolkit = new Map(configs.map((config) => [config.toolkit, config]));
    const connectedByToolkit = new Map<string, (typeof connections)[number]>();
    for (const row of connections) {
      const existing = connectedByToolkit.get(row.toolkit);
      if (!existing || (existing.status !== "active" && row.status === "active")) {
        connectedByToolkit.set(row.toolkit, row);
      }
    }

    const items: AppCard[] = page.items.map((toolkit) => {
      const config = byToolkit.get(toolkit.slug);
      const connection = connectedByToolkit.get(toolkit.slug);
      return {
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.description,
        logoUrl: toolkit.logoUrl,
        appUrl: toolkit.appUrl,
        categories: toolkit.categories,
        toolsCount: toolkit.toolsCount,
        support: toolkit.support,
        authConfigId: config?.id ?? null,
        authConfigManaged: config ? config.managed && !config.userSupplied : null,
        state: connection ? stateFromStatus(connection.status) : "available",
        connectionId: connection?.id ?? null,
        statusDetail: connection?.statusDetail ?? null,
        lastError: connection?.status === "error" ? connection.lastError ?? null : null,
      };
    });

    const categories = [...new Set(items.flatMap((item) => item.categories))].sort((a, b) => a.localeCompare(b));
    return { items, nextCursor: page.nextCursor, categories, configured: true, error: null };
  } catch (error) {
    return {
      items: [],
      nextCursor: null,
      categories: [],
      configured: true,
      error: describeError(error),
    };
  }
}

/**
 * Starts a connection: reuse or create the project's auth config for the toolkit,
 * then ask Composio for a hosted link. The row is written before the browser leaves
 * for Composio, so a connection that finishes while we are not looking is still
 * found and polled.
 */
export async function startConnection(input: {
  userId: string;
  workspaceId: string;
  toolkit: string;
  callbackUrl?: string;
}): Promise<{ redirectUrl: string; connectionId: string }> {
  const client = requireComposio();

  const existing = await database()
    .select()
    .from(appConnection)
    .where(
      and(
        eq(appConnection.userId, input.userId),
        eq(appConnection.toolkit, input.toolkit),
        eq(appConnection.status, "active"),
      ),
    )
    .limit(1);
  if (existing[0]) throw new AppError("That app is already connected.");

  const toolkit = await client.getToolkit(input.toolkit);
  if (!toolkit) throw new AppError(`Composio has no app called ${input.toolkit}.`);

  const config = await client.ensureAuthConfig({
    toolkit: toolkit.slug,
    authSchemes: toolkit.authSchemes,
    managedAuthSchemes: toolkit.managedAuthSchemes,
    name: `${toolkit.name} (PupBot)`,
  });

  const link = await client.startLink({
    authConfigId: config.id,
    userId: input.userId,
    alias: input.toolkit,
    callbackUrl: input.callbackUrl,
  });

  // Keyed by Composio's account id, so asking twice for the same link converges on
  // one row instead of failing a person's click on a unique constraint.
  await database()
    .insert(appConnection)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      toolkit: toolkit.slug,
      name: toolkit.name,
      composioAccountId: link.connectedAccountId,
      authConfigId: config.id,
      status: "pending",
      statusDetail: "INITIALIZING",
      lastCheckedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appConnection.composioAccountId,
      set: {
        status: "pending",
        statusDetail: "INITIALIZING",
        lastError: null,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  return { redirectUrl: link.redirectUrl, connectionId: link.connectedAccountId };
}

/**
 * Disconnect: revoke at Composio and forget the row. Composio is the only holder
 * of the credential, so revoking there is what actually ends the grant; a local
 * delete without it would leave a live connection behind.
 */
export async function disconnectConnection(input: { userId: string; connectionId: string }): Promise<void> {
  const rows = await database()
    .select()
    .from(appConnection)
    .where(and(eq(appConnection.id, input.connectionId), eq(appConnection.userId, input.userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("That connection is not yours.");

  const client = composioClient();
  if (client) {
    try {
      await client.deleteConnection(row.composioAccountId);
    } catch (error) {
      if (!(error instanceof ComposioError) || error.code !== "not_found") {
        throw new AppError(`Composio could not revoke the connection: ${describeError(error)}`);
      }
    }
  }

  await database().delete(appConnection).where(eq(appConnection.id, row.id));
}

/** The apps a bot may use. Nothing consumes this in a run yet; the UI says so. */
export async function setBotApp(input: {
  workspaceId: string;
  botId: string;
  connectionId: string;
  enabled: boolean;
}): Promise<void> {
  const db = database();
  // The connection and the bot both have to belong to this workspace, or a bot
  // could be granted an account from another tenant.
  const [connection] = await db
    .select({ id: appConnection.id, status: appConnection.status })
    .from(appConnection)
    .where(
      and(eq(appConnection.id, input.connectionId), eq(appConnection.workspaceId, input.workspaceId)),
    )
    .limit(1);
  if (!connection) throw new AppError("That app connection no longer exists.");
  if (connection.status !== "active") throw new AppError("Connect the app before a bot can use it.");

  const [owner] = await db
    .select({ id: botTable.id })
    .from(botTable)
    .where(and(eq(botTable.id, input.botId), eq(botTable.workspaceId, input.workspaceId)))
    .limit(1);
  if (!owner) throw new AppError("That bot is not in this workspace.");

  if (input.enabled) {
    await db
      .insert(botApp)
      .values({ id: newId(), botId: input.botId, connectionId: input.connectionId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(botApp)
      .where(and(eq(botApp.botId, input.botId), eq(botApp.connectionId, input.connectionId)));
  }
}

export async function botAppIds(botId: string): Promise<string[]> {
  const rows = await database()
    .select({ connectionId: botApp.connectionId })
    .from(botApp)
    .where(eq(botApp.botId, botId));
  return rows.map((row) => row.connectionId);
}

/** A message safe to show a person: never the API key, never a raw stack. */
export function describeError(error: unknown): string {
  if (error instanceof ComposioError) {
    switch (error.code) {
      case "not_configured":
        return error.message;
      case "unauthorized":
        return "Composio rejected this server's API key.";
      case "rate_limited":
        return "Composio is rate-limiting this server. Try again in a moment.";
      case "network":
      case "timeout":
        return "Composio did not answer. Check the connection and try again.";
      default:
        return error.message;
    }
  }
  // Ours are written for a person; anything else (a driver error, a failed insert)
  // is not, so the UI gets a sentence instead of a query string.
  if (error instanceof AppError) return error.message;
  return "Something went wrong while saving the app connection. Try again.";
}

