"use server";

import {
  encryptSecret,
  findCatalogMatch,
  newId,
  bot as botTable,
  botSection,
  conversation,
  database,
  modelCatalog,
  modelEndpoint,
  user as userTable,
} from "@terabot/db";
import {
  createGateway,
  listEndpointModels,
  ModelListingError,
  providerHintForBaseUrl,
} from "@terabot/providers";
import type { EndpointKind, ModelEndpointConfig, ModelEvent } from "@terabot/providers";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { allocateComputerInline, inlineComputers } from "../lib/computers-inline.ts";
import { ensureComputerPool } from "../lib/computers.ts";
import { endpointConfigFor } from "../lib/endpoint-config.ts";
import {
  assertPublicDestination,
  assertPublicEndpointUrl,
  isPublicDestination,
  publicOnlyFetch,
} from "../lib/outbound.ts";
import { enqueueComputerProvision } from "../lib/queue.ts";
import { currentWorkspace, requireUser } from "../lib/session.ts";

const MAX_NAME = 60;
const MAX_INSTRUCTIONS = 8000;

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

async function context() {
  const user = await requireUser();
  const workspace = await currentWorkspace(user);
  return { user, workspace, db: database() };
}

async function ownedBot(workspaceId: string, botId: string) {
  const rows = await database()
    .select()
    .from(botTable)
    .where(and(eq(botTable.id, botId), eq(botTable.workspaceId, workspaceId)))
    .limit(1);
  const found = rows[0];
  if (!found) throw new Error("bot not found in this workspace");
  return found;
}

export interface BotInput {
  name: string;
  shape: string;
  color: string;
  accentColor: string;
  /** A provider configured in Settings; the bot can only chat through one. */
  endpointId?: string | null;
  /** The model this bot uses on that provider. */
  modelId?: string | null;
}

export async function createBot(input: BotInput): Promise<{ botId: string }> {
  const { workspace, db } = await context();
  const botId = newId();
  const conversationId = newId();

  const [{ value: existing } = { value: 0 }] = await db
    .select({ value: count() })
    .from(botTable)
    .where(eq(botTable.workspaceId, workspace.id));

  // The choice comes from the create dialog, which only offers configured
  // providers; a caller that passes none falls back to the workspace's first so
  // an existing script still lands on something that can answer.
  let endpointId: string | null = null;
  let modelId: string | null = null;
  if (input.endpointId) {
    const [chosen] = await db
      .select({ id: modelEndpoint.id, modelId: modelEndpoint.modelId })
      .from(modelEndpoint)
      .where(and(eq(modelEndpoint.id, input.endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
      .limit(1);
    if (!chosen) throw new Error("that provider is not in this workspace");
    endpointId = chosen.id;
    modelId = clean(input.modelId ?? "", 200) || chosen.modelId || null;
  } else {
    const [fallback] = await db
      .select({ id: modelEndpoint.id, modelId: modelEndpoint.modelId })
      .from(modelEndpoint)
      .where(eq(modelEndpoint.workspaceId, workspace.id))
      .limit(1);
    endpointId = fallback?.id ?? null;
    modelId = fallback?.modelId ?? null;
  }

  await db.transaction(async (tx) => {
    await tx.insert(botTable).values({
      id: botId,
      workspaceId: workspace.id,
      name: clean(input.name, MAX_NAME) || "Terabot",
      avatar: { shape: input.shape, color: input.color },
      accentColor: input.accentColor,
      instructions: "",
      modelEndpointId: endpointId,
      modelId,
      position: Number(existing),
    });
    await tx.insert(conversation).values({
      id: conversationId,
      botId,
      title: clean(input.name, MAX_NAME) || "Terabot",
      isPrimary: Number(existing) === 0,
    });
  });

  revalidatePath("/", "layout");
  return { botId };
}

export async function renameBot(botId: string, name: string): Promise<void> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);
  const next = clean(name, MAX_NAME);
  if (!next) return;
  await db.update(botTable).set({ name: next, updatedAt: new Date() }).where(eq(botTable.id, botId));
  await db.update(conversation).set({ title: next }).where(eq(conversation.botId, botId));
  revalidatePath("/", "layout");
}

export async function deleteBot(botId: string): Promise<void> {
  const { workspace, db } = await context();
  const found = await ownedBot(workspace.id, botId);
  const [wasPrimary] = await db
    .select({ isPrimary: conversation.isPrimary })
    .from(conversation)
    .where(eq(conversation.botId, botId))
    .limit(1);

  await db.delete(botTable).where(eq(botTable.id, botId));

  if (found && wasPrimary?.isPrimary) {
    const next = await db
      .select({ id: botTable.id })
      .from(botTable)
      .where(eq(botTable.workspaceId, workspace.id))
      .orderBy(asc(botTable.position))
      .limit(1);
    if (next[0]) {
      await db.update(conversation).set({ isPrimary: true }).where(eq(conversation.botId, next[0].id));
    }
  }
  revalidatePath("/", "layout");
}

export async function setBotFlags(
  botId: string,
  flags: { hidden?: boolean; pinned?: boolean; unread?: boolean },
): Promise<void> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);
  await db
    .update(botTable)
    .set({ ...flags, updatedAt: new Date() })
    .where(eq(botTable.id, botId));
  revalidatePath("/", "layout");
}

export async function moveBotToSection(botId: string, input: { sectionId?: string | null; newSectionName?: string }): Promise<void> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);

  if (input.newSectionName !== undefined) {
    const [{ value: existing } = { value: 0 }] = await db
      .select({ value: count() })
      .from(botSection)
      .where(eq(botSection.workspaceId, workspace.id));
    const sectionId = newId();
    await db.insert(botSection).values({
      id: sectionId,
      workspaceId: workspace.id,
      name: clean(input.newSectionName, MAX_NAME) || "New section",
      position: Number(existing),
    });
    await db.update(botTable).set({ sectionId }).where(eq(botTable.id, botId));
  } else {
    await db.update(botTable).set({ sectionId: input.sectionId ?? null }).where(eq(botTable.id, botId));
  }
  revalidatePath("/", "layout");
}

export async function setPrimaryBot(botId: string): Promise<void> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);

  await db.transaction(async (tx) => {
    await tx
      .update(conversation)
      .set({ isPrimary: false })
      .where(
        sql`${conversation.botId} in (select id from ${botTable} where ${botTable.workspaceId} = ${workspace.id})`,
      );
    await tx.update(conversation).set({ isPrimary: true }).where(eq(conversation.botId, botId));
  });
  revalidatePath("/", "layout");
}

export interface BotSettingsInput {
  name: string;
  instructions: string;
  shape: string;
  color: string;
  accentColor: string;
  endpointId: string | null;
  modelId: string | null;
}

export async function updateBotSettings(botId: string, input: BotSettingsInput): Promise<void> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);
  const name = clean(input.name, MAX_NAME);
  if (!name) throw new Error("a bot needs a name");

  // The run decrypts this endpoint's key and calls its base URL, so a bot may
  // only point at an endpoint of its own workspace.
  if (input.endpointId !== null) {
    const owned = await db
      .select({ id: modelEndpoint.id })
      .from(modelEndpoint)
      .where(and(eq(modelEndpoint.id, input.endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
      .limit(1);
    if (!owned[0]) throw new Error("that model endpoint does not belong to this workspace");
  }

  await db
    .update(botTable)
    .set({
      name,
      instructions: clean(input.instructions, MAX_INSTRUCTIONS),
      avatar: { shape: input.shape, color: input.color },
      accentColor: input.accentColor,
      modelEndpointId: input.endpointId,
      modelId: input.modelId,
      updatedAt: new Date(),
    })
    .where(eq(botTable.id, botId));
  await db.update(conversation).set({ title: name }).where(eq(conversation.botId, botId));
  revalidatePath("/", "layout");
}

/**
 * The one-click fix behind a blocked composer, and the "Connect a computer"
 * button. On a queue deployment this marks the bot and lets the worker allocate;
 * on an inline deployment there is no worker to drain that queue, so the request
 * allocates directly instead of leaving the bot in `binding` forever.
 */
export async function giveComputer(botId: string): Promise<{ state: string; reason: string | null }> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);

  try {
    await ensureComputerPool();

    // Inline mode provisions here: nothing drains the queue on this host, so a
    // bot left on a job would sit in `binding` forever. A bound bot returns its
    // machine without provisioning, and a blocked one retries.
    if (inlineComputers()) {
      const result = await allocateComputerInline(botId);
      revalidatePath("/", "layout");
      return { state: result.state, reason: result.reason ?? null };
    }

    // Queue mode marks before publishing: the worker can finish the whole
    // allocation first, and a "binding" write after that would erase a ready or
    // blocked result it already committed.
    await db
      .update(botTable)
      .set({ computerState: "binding", computerReason: null, updatedAt: new Date() })
      .where(eq(botTable.id, botId));
    await enqueueComputerProvision(botId);
  } catch (error) {
    const reason = "The computer service is not reachable; try again.";
    await db
      .update(botTable)
      .set({ computerState: "blocked", computerReason: reason, updatedAt: new Date() })
      .where(eq(botTable.id, botId));
    revalidatePath("/", "layout");
    throw new Error(`${reason} (${error instanceof Error ? error.message : String(error)})`);
  }

  revalidatePath("/", "layout");
  return { state: "binding", reason: null };
}

export interface EndpointInput {
  label: string;
  kind: EndpointKind;
  baseUrl: string;
  /** Optional provider default; the first id the provider lists is used when omitted. */
  modelId?: string;
  apiKey?: string;
}

/** The catalogue provider a kind belongs to, for defaulting a model. */
function providerForKind(kind: EndpointKind): string {
  return kind === "anthropic-messages" ? "anthropic" : "openai";
}

/**
 * Picks the model a provider row stores as its default: the provider's own first
 * listing, else the newest tool-capable catalogue model for that kind, else empty
 * (a bot's own pick decides).
 */
async function defaultModelFor(
  db: ReturnType<typeof database>,
  config: ModelEndpointConfig,
): Promise<string> {
  const listed = await listEndpointModels(config, { fetch: publicOnlyFetch })
    .then((listing) => listing.models[0]?.id ?? "")
    .catch(() => "");
  if (listed) return listed;
  const suggested = await suggestCatalogModel(providerForKind(config.kind));
  return suggested?.modelId ?? "";
}

const providerHintFor = providerHintForBaseUrl;

function providerLabel(kind: EndpointKind): string {
  if (kind === "anthropic-messages") return "Anthropic";
  if (kind === "openai-responses") return "OpenAI Responses";
  return "OpenAI";
}

/**
 * Shape check for a saved base URL: absolute http(s) only. Private hosts are
 * deliberately allowed here — a local llama.cpp or a LAN gateway is a
 * legitimate BYO endpoint — while `testModelEndpoint` refuses to probe them
 * from the server, which is where the SSRF risk lives.
 */
function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the base URL must use http or https");
  }
  return url.toString();
}

export interface EndpointResult {
  endpointId: string;
  match: "matched" | "unmatched";
  contextWindow: number | null;
  modelName: string | null;
  modelId: string;
}

export interface EndpointModelChoice {
  id: string;
  name: string | null;
  contextWindow: number | null;
  pricing: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  /** Present in the endpoint's own `GET /models` answer. */
  live: boolean;
  /** Present in the models.dev snapshot, so its price is known. */
  inCatalogue: boolean;
}

export interface EndpointModelChoices {
  /** live: the endpoint answered; catalogue: only models.dev is available. */
  source: "live" | "catalogue";
  fetchedAt: string | null;
  models: EndpointModelChoice[];
  /** One plain sentence to show under the picker. */
  note: string;
}

async function mergeWithCatalogue(
  db: ReturnType<typeof database>,
  rows: Array<{ id: string }>,
  providerHint: string | undefined,
): Promise<EndpointModelChoice[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const catalogue = await db
    .select()
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, ids));
  const best = new Map<string, (typeof catalogue)[number]>();
  for (const row of catalogue) {
    const current = best.get(row.modelId);
    const better =
      !current ||
      (providerHint && row.provider === providerHint && current.provider !== providerHint) ||
      (current.provider !== providerHint && row.pricing !== null && current.pricing === null);
    if (better) best.set(row.modelId, row);
  }
  return rows.map((row) => {
    const match = best.get(row.id);
    return {
      id: row.id,
      name: match?.name ?? null,
      contextWindow: match?.contextWindow ?? null,
      pricing: match?.pricing ?? null,
      live: true,
      inCatalogue: Boolean(match),
    };
  });
}

function modelListNote(count: number): string {
  return `Model list: from this endpoint · ${count} model${count === 1 ? "" : "s"}`;
}

/**
 * Reads the endpoint's own model list (`GET {baseUrl}/models`) and caches it on
 * the row. A listing failure is never fatal: the picker falls back to
 * models.dev and the note explains why.
 */
export async function refreshEndpointModels(endpointId: string): Promise<EndpointModelChoices> {
  const { workspace, db } = await context();
  const [endpoint] = await db
    .select()
    .from(modelEndpoint)
    .where(and(eq(modelEndpoint.id, endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
    .limit(1);
  if (!endpoint) throw new Error("that endpoint is not in this workspace");

  if (!(await isPublicDestination(endpoint.baseUrl))) {
    return {
      source: "catalogue",
      fetchedAt: null,
      models: [],
      note: "This provider is on a private network, so its model list is not read; set the model by hand.",
    };
  }

  try {
    const config = await endpointConfigFor(db, endpoint);
    const listing = await listEndpointModels(config, { fetch: publicOnlyFetch });
    if (listing.models.length === 0) {
      return {
        source: "catalogue",
        fetchedAt: listing.fetchedAt,
        models: [],
        note: "This endpoint listed no models; the picker uses models.dev instead.",
      };
    }
    await db
      .update(modelEndpoint)
      .set({ modelList: listing.models, modelListFetchedAt: new Date(listing.fetchedAt) })
      .where(eq(modelEndpoint.id, endpointId));
    revalidatePath("/", "layout");
    const merged = await mergeWithCatalogue(db, listing.models, providerHintFor(endpoint.baseUrl));
    return {
      source: "live",
      fetchedAt: listing.fetchedAt,
      models: merged,
      note: modelListNote(merged.length),
    };
  } catch (error) {
    const code = error instanceof ModelListingError ? error.code : "unknown";
    const message =
      code === "no_model_listing"
        ? "This endpoint does not list its models; the picker uses models.dev instead."
        : error instanceof Error
          ? error.message
          : "the model list could not be read";
    return {
      source: "catalogue",
      fetchedAt: null,
      models: [],
      note: code === "no_model_listing" ? message : `Could not read this endpoint's model list — ${message}`,
    };
  }
}

/** Cached list when we have one; otherwise one bounded attempt, then catalogue. */
export async function endpointModelChoices(endpointId: string): Promise<EndpointModelChoices> {
  const { workspace, db } = await context();
  const [endpoint] = await db
    .select()
    .from(modelEndpoint)
    .where(and(eq(modelEndpoint.id, endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
    .limit(1);
  if (!endpoint) return { source: "catalogue", fetchedAt: null, models: [], note: "" };

  if (endpoint.modelList && endpoint.modelList.length > 0) {
    const merged = await mergeWithCatalogue(db, endpoint.modelList, providerHintFor(endpoint.baseUrl));
    return {
      source: "live",
      fetchedAt: endpoint.modelListFetchedAt?.toISOString() ?? null,
      models: merged,
      note: modelListNote(merged.length),
    };
  }
  return refreshEndpointModels(endpointId);
}

export async function addModelEndpoint(input: EndpointInput): Promise<EndpointResult> {
  const { workspace, db } = await context();
  const baseUrl = parseBaseUrl(clean(input.baseUrl, 300));
  const kind = input.kind;
  const apiKey = input.apiKey?.trim();
  const requested = clean(input.modelId ?? "", 200);
  const modelId =
    requested || (await defaultModelFor(db, { kind, baseUrl, model: "", ...(apiKey ? { apiKey } : {}) }));

  const match = await findCatalogMatch(db, { modelId, providerHint: providerHintFor(baseUrl) });
  const endpointId = newId();
  await db.insert(modelEndpoint).values({
    id: endpointId,
    workspaceId: workspace.id,
    kind,
    label: clean(input.label, MAX_NAME) || providerLabel(kind),
    baseUrl,
    modelId,
    encryptedKey: apiKey ? encryptSecret(apiKey) : null,
    modelCatalogId: match.row?.id ?? null,
    catalogMatch: match.match,
    contextWindow: match.row?.contextWindow ?? null,
  });

  revalidatePath("/", "layout");
  // Best effort: a provider that lists nothing must still save.
  await refreshEndpointModels(endpointId).catch(() => undefined);

  return {
    endpointId,
    match: match.match,
    contextWindow: match.row?.contextWindow ?? null,
    modelName: match.row?.name ?? null,
    modelId,
  };
}

export interface ProviderUpdate {
  endpointId: string;
  label: string;
  kind: EndpointKind;
  baseUrl: string;
  /** A new key; omitted or blank keeps the stored one. */
  apiKey?: string;
  /** Explicitly forget the stored key. */
  clearKey?: boolean;
}

export async function updateModelEndpointProvider(input: ProviderUpdate): Promise<void> {
  const { workspace, db } = await context();
  const [endpoint] = await db
    .select()
    .from(modelEndpoint)
    .where(and(eq(modelEndpoint.id, input.endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
    .limit(1);
  if (!endpoint) throw new Error("that provider is not in this workspace");

  const baseUrl = parseBaseUrl(clean(input.baseUrl, 300));
  const apiKey = input.apiKey?.trim();
  // What the row will connect to afterwards. A different target has different
  // models, so neither its default model nor its cached listing can carry over:
  // a bot created without touching the picker would send an id the new provider
  // never had.
  const retargeted =
    input.kind !== endpoint.kind || baseUrl !== endpoint.baseUrl || Boolean(apiKey) || Boolean(input.clearKey);
  const stored = await endpointConfigFor(db, endpoint);
  const effective: ModelEndpointConfig = {
    kind: input.kind,
    baseUrl,
    model: "",
    ...(apiKey ? { apiKey } : input.clearKey || !stored.apiKey ? {} : { apiKey: stored.apiKey }),
  };
  const modelId = retargeted ? await defaultModelFor(db, effective) : endpoint.modelId;
  const match = await findCatalogMatch(db, {
    modelId,
    providerHint: providerHintFor(baseUrl),
  });

  await db
    .update(modelEndpoint)
    .set({
      label: clean(input.label, MAX_NAME) || providerLabel(input.kind),
      kind: input.kind,
      baseUrl,
      modelId,
      modelCatalogId: match.row?.id ?? null,
      catalogMatch: match.match,
      contextWindow: match.row?.contextWindow ?? null,
      ...(retargeted ? { modelList: null, modelListFetchedAt: null } : {}),
      ...(apiKey ? { encryptedKey: encryptSecret(apiKey) } : input.clearKey ? { encryptedKey: null } : {}),
    })
    .where(eq(modelEndpoint.id, endpoint.id));

  revalidatePath("/", "layout");
  await refreshEndpointModels(endpoint.id).catch(() => undefined);
}

export async function deleteModelEndpoint(endpointId: string): Promise<void> {
  const { workspace, db } = await context();
  const [endpoint] = await db
    .select({ id: modelEndpoint.id })
    .from(modelEndpoint)
    .where(and(eq(modelEndpoint.id, endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
    .limit(1);
  if (!endpoint) throw new Error("that provider is not in this workspace");

  await db.transaction(async (tx) => {
    // A bot cannot chat without a provider: unbind it here so the UI can say so
    // instead of the next message failing against a row that no longer exists.
    await tx
      .update(botTable)
      .set({ modelEndpointId: null, modelId: null })
      .where(eq(botTable.modelEndpointId, endpoint.id));
    await tx.delete(modelEndpoint).where(eq(modelEndpoint.id, endpoint.id));
  });
  revalidatePath("/", "layout");
}

export interface ProviderProbe {
  /** Ids the provider itself listed, newest-first as it ordered them. */
  models: string[];
  note: string;
  test: TestEndpointResult | null;
}

/**
 * "Test connection" for a provider: ask it what it serves, then make one real
 * call with the first id so a saved key is proven, not just reachable.
 *
 * The draft fields win over the saved row, so an edited provider is tested as it
 * would be saved — a replaced key is proven before Save keeps it.
 */
export async function probeProviderEndpoint(input: {
  endpointId?: string;
  kind: EndpointKind;
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderProbe> {
  const { workspace, db } = await context();
  let config: ModelEndpointConfig;
  let savedModel = "";
  let unchanged = false;

  if (input.endpointId) {
    const [endpoint] = await db
      .select()
      .from(modelEndpoint)
      .where(and(eq(modelEndpoint.id, input.endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
      .limit(1);
    if (!endpoint) return { models: [], note: "that provider is not in this workspace", test: null };
    const stored = await endpointConfigFor(db, endpoint);
    const draftBaseUrl = clean(input.baseUrl ?? "", 300);
    const apiKey = input.apiKey?.trim() || stored.apiKey;
    let baseUrl: string;
    try {
      baseUrl = assertPublicEndpointUrl(draftBaseUrl || stored.baseUrl);
    } catch (error) {
      return { models: [], note: error instanceof Error ? error.message : "that base URL is not allowed", test: null };
    }
    config = { kind: input.kind, baseUrl, model: "", ...(apiKey ? { apiKey } : {}) };
    savedModel = endpoint.modelId;
    unchanged =
      config.baseUrl === stored.baseUrl && input.kind === stored.kind && !input.apiKey?.trim();
  } else {
    const baseUrl = clean(input.baseUrl ?? "", 300);
    if (!baseUrl) return { models: [], note: "a base URL is required", test: null };
    let parsed: string;
    try {
      parsed = assertPublicEndpointUrl(baseUrl);
    } catch (error) {
      return { models: [], note: error instanceof Error ? error.message : "that base URL is not allowed", test: null };
    }
    const apiKey = input.apiKey?.trim();
    config = { kind: input.kind, baseUrl: parsed, model: "", ...(apiKey ? { apiKey } : {}) };
  }

  const failure = await listEndpointModels(config, { fetch: publicOnlyFetch }).then(
    (result) => ({ result, error: null as ModelListingError | null }),
    (error: unknown) => ({
      result: null,
      error: error instanceof ModelListingError ? error : new ModelListingError("the model list could not be read", { code: "unknown" }),
    }),
  );
  const models = failure.result?.models.map((model) => model.id) ?? [];
  const note = failure.error
    ? failure.error.code === "no_model_listing"
      ? "This provider does not publish a model list; pick the model per bot."
      : `Could not read its model list — ${failure.error.message}`
    : `Model list: from this provider · ${models.length} model${models.length === 1 ? "" : "s"}`;

  const modelId = models[0] ?? (unchanged ? savedModel : await defaultModelFor(db, config));
  if (!modelId) return { models, note, test: null };
  const test = await testModelEndpoint({
    kind: config.kind,
    baseUrl: config.baseUrl,
    modelId,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
  if (test.ok && input.endpointId && unchanged) {
    await refreshEndpointModels(input.endpointId).catch(() => undefined);
  }
  return { models, note, test };
}

export async function updateProfile(name: string): Promise<void> {
  const { user, db } = await context();
  const next = clean(name, MAX_NAME);
  if (!next) return;
  await db.update(userTable).set({ name: next }).where(eq(userTable.id, user.id));
  revalidatePath("/", "layout");
}

/* ───────────────────────────── model catalogue ───────────────────────────── */

export interface CatalogModelView {
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number | null;
  maxOutput: number | null;
  pricing: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  toolSupport: boolean;
  reasoning: boolean;
}

type CatalogRow = typeof modelCatalog.$inferSelect;

function toCatalogModelView(row: CatalogRow): CatalogModelView {
  return {
    provider: row.provider,
    modelId: row.modelId,
    name: row.name,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    pricing: row.pricing ?? null,
    toolSupport: row.toolSupport,
    reasoning: row.reasoning,
  };
}

/** Search the models.dev snapshot for the model picker. */
export async function searchCatalogModels(
  input: { query?: string; provider?: string; limit?: number } = {},
): Promise<CatalogModelView[]> {
  await context();
  const needle = clean(input.query ?? "", 100);
  const provider = clean(input.provider ?? "", 60);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));

  const filters = [
    ...(provider ? [eq(modelCatalog.provider, provider)] : []),
    ...(needle
      ? [or(ilike(modelCatalog.modelId, `%${needle}%`), ilike(modelCatalog.name, `%${needle}%`))!]
      : []),
  ];

  const rows = await database()
    .select()
    .from(modelCatalog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(modelCatalog.provider), asc(modelCatalog.modelId))
    .limit(limit);
  return rows.map(toCatalogModelView);
}

/**
 * The default model for a provider when someone connects an account: the newest
 * tool-capable one in the catalogue, so the simple path arrives with a model
 * that works instead of an empty field.
 */
export async function suggestCatalogModel(provider: string): Promise<CatalogModelView | null> {
  await context();
  const db = database();
  const wanted = clean(provider, 60);
  const rows = await db
    .select()
    .from(modelCatalog)
    .where(and(eq(modelCatalog.provider, wanted), eq(modelCatalog.toolSupport, true)))
    .orderBy(desc(sql`coalesce((${modelCatalog.raw}->'model'->>'release_date'), '')`))
    .limit(1);
  if (rows[0]) return toCatalogModelView(rows[0]);

  const fallback = await db
    .select()
    .from(modelCatalog)
    .where(eq(modelCatalog.provider, wanted))
    .orderBy(desc(sql`coalesce((${modelCatalog.raw}->'model'->>'release_date'), '')`))
    .limit(1);
  return fallback[0] ? toCatalogModelView(fallback[0]) : null;
}

/** Exact lookup used to show context and pricing, or warn that a model is unmatched. */
export async function lookupCatalogModel(input: {
  modelId: string;
  providerHint?: string;
}): Promise<CatalogModelView | null> {
  await context();
  const modelId = clean(input.modelId, 200);
  const match = await findCatalogMatch(database(), {
    modelId,
    providerHint: input.providerHint ? clean(input.providerHint, 60) : undefined,
  });
  return match.row ? toCatalogModelView(match.row) : null;
}

/* ─────────────────────────── test connection ──────────────────────────── */

export interface TestEndpointInput {
  /** An already saved endpoint. */
  endpointId?: string;
  kind?: EndpointKind;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

export interface TestEndpointResult {
  ok: boolean;
  latencyMs: number;
  text: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  error: { code: string; status?: number; message: string } | null;
}

const TEST_TIMEOUT_MS = 25_000;

/** Makes one minimal real call through the gateway and reports exactly what happened. */
export async function testModelEndpoint(input: TestEndpointInput): Promise<TestEndpointResult> {
  const { workspace, db } = await context();
  const started = Date.now();

  const fail = (message: string, code = "invalid_request", status?: number): TestEndpointResult => ({
    ok: false,
    latencyMs: Date.now() - started,
    text: null,
    usage: null,
    error: { code, message, ...(status !== undefined ? { status } : {}) },
  });

  let config: ModelEndpointConfig;
  try {
    if (input.endpointId) {
      const [endpoint] = await db
        .select()
        .from(modelEndpoint)
        .where(and(eq(modelEndpoint.id, input.endpointId), eq(modelEndpoint.workspaceId, workspace.id)))
        .limit(1);
      if (!endpoint) return fail("that endpoint is not in this workspace", "not_found", 404);
      // Saved endpoints can be custom; only block private/local targets, resolved,
      // to prevent SSRF probes while keeping BYO gateways usable for chat.
      try {
        await assertPublicDestination(endpoint.baseUrl);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "the base URL is not allowed");
      }
      config = await endpointConfigFor(db, endpoint, input.modelId ? clean(input.modelId, 200) : undefined);
    } else {
      const kind = input.kind ?? "openai-chat";
      const baseUrlRaw = clean(input.baseUrl ?? "", 2000);
      const modelId = clean(input.modelId ?? "", 200);
      if (!baseUrlRaw || !modelId) return fail("a base URL and a model id are required");
      let baseUrl: string;
      try {
        baseUrl = await assertPublicDestination(baseUrlRaw);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "the base URL is not a valid URL");
      }
      config = {
        kind,
        baseUrl,
        model: modelId,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "the endpoint could not be prepared");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let text = "";
  let usage: TestEndpointResult["usage"] = null;
  let failure: TestEndpointResult["error"] = null;

  try {
    for await (const event of createGateway().stream({
      endpoint: config,
      messages: [{ role: "user", content: "Reply with the single word: pong." }],
      maxTokens: 32,
      temperature: 0,
      signal: controller.signal,
      fetch: publicOnlyFetch,
    }) as AsyncIterable<ModelEvent>) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "usage") {
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      } else if (event.type === "error") {
        failure = {
          code: event.code ?? "error",
          ...(event.status !== undefined ? { status: event.status } : {}),
          message: event.message,
        };
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failure = { code: "provider_error", message: error instanceof Error ? error.message : "the call failed" };
    }
  } finally {
    clearTimeout(timeout);
  }

  if (controller.signal.aborted && !failure) {
    return fail(`the test timed out after ${TEST_TIMEOUT_MS / 1000} s`, "timeout");
  }
  if (failure) return { ok: false, latencyMs: Date.now() - started, text: null, usage, error: failure };

  // A working call is the moment we know the endpoint can answer, so learn what
  // it actually serves. A listing failure must never fail the test.
  if (input.endpointId) {
    await refreshEndpointModels(input.endpointId).catch(() => undefined);
  }

  return {
    ok: true,
    latencyMs: Date.now() - started,
    text: text.trim() || null,
    usage,
    error: null,
  };
}

