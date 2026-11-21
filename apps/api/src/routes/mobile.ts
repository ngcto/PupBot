import { colorHex, deriveAccent, isColorId, isShapeId } from "@terabot/avatars";
import {
  auth,
  bot as botTable,
  botComputer,
  computer,
  conversation,
  database,
  findWorkspace,
  message,
  modelEndpoint,
  run,
} from "@terabot/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.ts";

/**
 * The JSON surface a native client needs, mounted at `/m`.
 *
 * It exists so the phone app does not re-implement the web app's server
 * components: the same DB queries, the same `better-auth` session, and the same
 * conversation/run endpoints (`/conversations/:id/messages`, `/runs/:id/events`)
 * for chat. Purely additive — no existing route changes shape here.
 */

const signInSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
});

const avatarPatchSchema = z.object({
  avatar: z.object({ shape: z.string().min(1), color: z.string().min(1) }),
});

const COOKIE_NAME = /^[^=;,\s]+$/;

/**
 * `Set-Cookie` is one header per cookie, but a combined header splits on commas
 * that also appear inside `Expires`. Split only where a new `name=` starts.
 */
export function splitSetCookie(combined: string): string[] {
  if (!combined) return [];
  return combined
    .split(/,(?=\s*[^=;,\s]+\s*=)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function cookiePairs(setCookies: string[]): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = [];
  for (const header of setCookies) {
    const [pair] = header.split(";");
    const trimmed = pair?.trim() ?? "";
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const name = trimmed.slice(0, equals);
    if (!COOKIE_NAME.test(name)) continue;
    pairs.push({ name, value: trimmed.slice(equals + 1) });
  }
  return pairs;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

interface WorkspaceScope {
  workspaceId: string;
}

async function workspaceOf(userId: string): Promise<WorkspaceScope | null> {
  const workspace = await findWorkspace(userId);
  return workspace ? { workspaceId: workspace.id } : null;
}

function botQuery(workspaceId: string, botId?: string) {
  const db = database();
  return db
    .select({
      id: botTable.id,
      name: botTable.name,
      avatar: botTable.avatar,
      accentColor: botTable.accentColor,
      instructions: botTable.instructions,
      pinned: botTable.pinned,
      unread: botTable.unread,
      position: botTable.position,
      createdAt: botTable.createdAt,
      modelId: botTable.modelId,
      conversationId: conversation.id,
      lastMessagePreview: conversation.lastMessagePreview,
      lastMessageAt: conversation.updatedAt,
      isPrimary: conversation.isPrimary,
      computerId: computer.id,
      computerProvider: computer.provider,
      computerStatus: computer.status,
      computerLastUsedAt: computer.lastUsedAt,
      endpointId: modelEndpoint.id,
      endpointLabel: modelEndpoint.label,
      endpointKind: modelEndpoint.kind,
      endpointModelId: modelEndpoint.modelId,
      endpointContextWindow: modelEndpoint.contextWindow,
      endpointCatalogMatch: modelEndpoint.catalogMatch,
    })
    .from(botTable)
    .leftJoin(conversation, eq(conversation.botId, botTable.id))
    .leftJoin(botComputer, and(eq(botComputer.botId, botTable.id), isNull(botComputer.releasedAt)))
    .leftJoin(computer, eq(computer.id, botComputer.computerId))
    .leftJoin(modelEndpoint, eq(modelEndpoint.id, botTable.modelEndpointId))
    .where(and(eq(botTable.workspaceId, workspaceId), botId ? eq(botTable.id, botId) : undefined))
    .orderBy(asc(botTable.position), asc(botTable.createdAt));
}

type BotRow = Awaited<ReturnType<typeof botQuery>>[number];

/** The bot's own model id wins over the endpoint's default, as in the web app. */
function modelView(row: BotRow) {
  if (!row.endpointId) return null;
  return {
    endpointId: row.endpointId,
    endpointLabel: row.endpointLabel ?? "Endpoint",
    kind: row.endpointKind ?? "openai-chat",
    modelId: row.modelId ?? row.endpointModelId ?? "",
    contextWindow: row.endpointContextWindow ?? null,
    catalogMatch: row.endpointCatalogMatch ?? "unmatched",
  };
}

function summary(row: BotRow, activeRun: boolean) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    accentColor: row.accentColor,
    unread: row.unread,
    pinned: row.pinned,
    isPrimary: row.isPrimary ?? false,
    position: row.position,
    conversationId: row.conversationId ?? "",
    lastMessagePreview: row.lastMessagePreview ?? null,
    lastMessageAt: iso(row.lastMessageAt),
    computer:
      row.computerId && row.computerProvider && row.computerStatus
        ? {
            id: row.computerId,
            provider: row.computerProvider,
            status: row.computerStatus,
            lastUsedAt: iso(row.computerLastUsedAt),
          }
        : null,
    model: modelView(row),
    activeRun,
  };
}

function detail(row: BotRow, activeRun: boolean) {
  return {
    ...summary(row, activeRun),
    instructions: row.instructions,
    createdAt: row.createdAt.toISOString(),
  };
}

async function activeConversations(conversationIds: string[]): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const rows = await database()
    .select({ conversationId: run.conversationId })
    .from(run)
    .where(and(inArray(run.conversationId, conversationIds), inArray(run.status, ["queued", "running"])));
  return new Set(rows.map((row) => row.conversationId));
}

async function ownedRow(workspaceId: string, botId: string): Promise<BotRow | null> {
  const rows = await botQuery(workspaceId, botId);
  return rows[0] ?? null;
}

function readSetCookie(headers: Headers): string[] {
  const candidates = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof candidates.getSetCookie === "function") return candidates.getSetCookie();
  return splitSetCookie(headers.get("set-cookie") ?? "");
}

export const mobileRoutes = new Hono<AppEnv>();

/**
 * The phone has no cookie jar it can trust, so sign-in returns the cookies
 * themselves. The client stores them in `expo-secure-store` and sends them back
 * as a `Cookie` header, which the API's existing session middleware already reads.
 */
mobileRoutes.post("/m/auth/sign-in", async (c) => {
  const parsed = signInSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await auth().api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      returnHeaders: true,
    });
    const cookies = cookiePairs(readSetCookie(result.headers));
    const user = result.response.user;
    return c.json({ user: { id: user.id, name: user.name, email: user.email }, cookies });
  } catch {
    return c.json({ error: "invalid_credentials", message: "That email and password do not match." }, 401);
  }
});

mobileRoutes.use("/m/*", async (c, next) => {
  const session = await auth().api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("user", session.user);
  await next();
});

mobileRoutes.get("/m/me", async (c) => {
  const scope = await workspaceOf(c.get("user").id);
  if (!scope) return c.json({ error: "no_workspace" }, 404);
  const user = c.get("user");
  return c.json({
    user: { id: user.id, name: user.name, email: user.email },
    workspaceId: scope.workspaceId,
  });
});

mobileRoutes.get("/m/bots", async (c) => {
  const scope = await workspaceOf(c.get("user").id);
  if (!scope) return c.json({ error: "no_workspace" }, 404);

  const rows = (await botQuery(scope.workspaceId)).filter((row) => row.conversationId);
  const active = await activeConversations(rows.map((row) => row.conversationId as string));
  return c.json({
    bots: rows.map((row) => summary(row, active.has(row.conversationId as string))),
  });
});

mobileRoutes.get("/m/bots/:id", async (c) => {
  const scope = await workspaceOf(c.get("user").id);
  if (!scope) return c.json({ error: "no_workspace" }, 404);

  const row = await ownedRow(scope.workspaceId, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);

  const active = row.conversationId ? await activeConversations([row.conversationId]) : new Set<string>();
  return c.json({ bot: detail(row, row.conversationId ? active.has(row.conversationId) : false) });
});

/**
 * Avatar only for v1: the phone is the wrong place to edit instructions or
 * endpoints, and both already live in the web app. The accent follows the
 * colour so the user bubble keeps the product's tint rule.
 */
mobileRoutes.patch("/m/bots/:id", async (c) => {
  const scope = await workspaceOf(c.get("user").id);
  if (!scope) return c.json({ error: "no_workspace" }, 404);

  const row = await ownedRow(scope.workspaceId, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);

  const parsed = avatarPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const { shape, color } = parsed.data.avatar;
  if (!isShapeId(shape) || !isColorId(color)) {
    return c.json({ error: "unknown_avatar", message: "That avatar is not in the registry." }, 400);
  }

  const accentColor = deriveAccent(colorHex(color));
  await database()
    .update(botTable)
    .set({ avatar: { shape, color }, accentColor, updatedAt: new Date() })
    .where(and(eq(botTable.id, row.id), eq(botTable.workspaceId, scope.workspaceId)));

  const updated = await ownedRow(scope.workspaceId, row.id);
  if (!updated) return c.json({ error: "not_found" }, 404);
  const active = updated.conversationId ? await activeConversations([updated.conversationId]) : new Set<string>();
  return c.json({ bot: detail(updated, updated.conversationId ? active.has(updated.conversationId) : false) });
});

mobileRoutes.get("/m/bots/:id/messages", async (c) => {
  const scope = await workspaceOf(c.get("user").id);
  if (!scope) return c.json({ error: "no_workspace" }, 404);

  const row = await ownedRow(scope.workspaceId, c.req.param("id"));
  if (!row?.conversationId) return c.json({ error: "not_found" }, 404);

  const db = database();
  const messages = await db
    .select()
    .from(message)
    .where(eq(message.conversationId, row.conversationId))
    .orderBy(asc(message.createdAt));

  const active = await db
    .select({ id: run.id, status: run.status })
    .from(run)
    .where(and(eq(run.conversationId, row.conversationId), inArray(run.status, ["queued", "running"])))
    .orderBy(desc(run.createdAt))
    .limit(1);

  return c.json({
    messages: messages.map((entry) => ({
      id: entry.id,
      role: entry.role,
      parts: entry.parts,
      status: entry.status,
      createdAt: entry.createdAt.toISOString(),
      runId: entry.runId,
    })),
    activeRun: active[0] ? { id: active[0].id, status: active[0].status } : null,
  });
});
