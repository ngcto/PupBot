"use server";

import { StubComputerProvider } from "@pupbot/computers";
import {
  encryptSecret,
  findCatalogMatch,
  newId,
  bot as botTable,
  botComputer,
  botSection,
  computer,
  computerAccount,
  conversation,
  database,
  modelEndpoint,
  user as userTable,
} from "@pupbot/db";
import { and, asc, eq, count, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
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
}

export async function createBot(input: BotInput): Promise<{ botId: string }> {
  const { workspace, db } = await context();
  const botId = newId();
  const conversationId = newId();

  const [{ value: existing } = { value: 0 }] = await db
    .select({ value: count() })
    .from(botTable)
    .where(eq(botTable.workspaceId, workspace.id));

  await db.transaction(async (tx) => {
    await tx.insert(botTable).values({
      id: botId,
      workspaceId: workspace.id,
      name: clean(input.name, MAX_NAME) || "PupBot",
      avatar: { shape: input.shape, color: input.color },
      accentColor: input.accentColor,
      instructions: "",
      position: Number(existing),
    });
    await tx.insert(conversation).values({
      id: conversationId,
      botId,
      title: clean(input.name, MAX_NAME) || "PupBot",
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
 * The one-click fix behind a blocked composer. Until real providers land this
 * binds a stub computer, which is exactly the allocator's interface.
 */
export async function giveComputer(botId: string): Promise<{ status: string }> {
  const { workspace, db } = await context();
  await ownedBot(workspace.id, botId);

  const accounts = await db
    .select()
    .from(computerAccount)
    .where(eq(computerAccount.provider, "stub"))
    .limit(1);

  let accountId = accounts[0]?.id;
  if (!accountId) {
    accountId = newId();
    await db.insert(computerAccount).values({
      id: accountId,
      provider: "stub",
      label: "Stub pool",
      encryptedCredential: encryptSecret("stub-account"),
      status: "active",
      capacity: 5,
    });
  }

  const provider = new StubComputerProvider();
  const ref = await provider.provision({ metadata: { botId } });

  const computerId = newId();
  await db.transaction(async (tx) => {
    await tx
      .update(botComputer)
      .set({ releasedAt: new Date() })
      .where(and(eq(botComputer.botId, botId), isNull(botComputer.releasedAt)));
    await tx.insert(computer).values({
      id: computerId,
      accountId,
      provider: ref.provider,
      externalId: ref.id,
      status: "awake",
      specs: { vcpus: 4, memMiB: 8192 },
      lastUsedAt: new Date(),
    });
    await tx.insert(botComputer).values({ id: newId(), botId, computerId });
  });

  revalidatePath("/", "layout");
  return { status: "awake" };
}

export interface EndpointInput {
  label: string;
  kind: "openai-chat" | "openai-responses" | "anthropic-messages" | "chatgpt-oauth";
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}

function providerHintFor(baseUrl: string): string | undefined {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const known: Array<[string, string]> = [
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["openrouter", "openrouter"],
    ["groq", "groq"],
    ["google", "google"],
    ["mistral", "mistral"],
    ["deepseek", "deepseek"],
    ["xai", "xai"],
  ];
  return known.find(([needle]) => host.includes(needle))?.[1];
}

export interface EndpointResult {
  endpointId: string;
  match: "matched" | "unmatched";
  contextWindow: number | null;
  modelName: string | null;
}

export async function addModelEndpoint(input: EndpointInput): Promise<EndpointResult> {
  const { workspace, db } = await context();
  const modelId = clean(input.modelId, 200);
  const baseUrl = clean(input.baseUrl, 2000);
  if (!modelId || !baseUrl) throw new Error("a model id and a base URL are required");

  const match = await findCatalogMatch(db, { modelId, providerHint: providerHintFor(baseUrl) });

  const endpointId = newId();
  await db.insert(modelEndpoint).values({
    id: endpointId,
    workspaceId: workspace.id,
    kind: input.kind,
    label: clean(input.label, MAX_NAME) || modelId,
    baseUrl,
    modelId,
    encryptedKey: input.apiKey ? encryptSecret(input.apiKey) : null,
    modelCatalogId: match.row?.id ?? null,
    catalogMatch: match.match,
    contextWindow: match.row?.contextWindow ?? null,
  });

  revalidatePath("/", "layout");
  return {
    endpointId,
    match: match.match,
    contextWindow: match.row?.contextWindow ?? null,
    modelName: match.row?.name ?? null,
  };
}

export async function updateProfile(name: string): Promise<void> {
  const { user, db } = await context();
  const next = clean(name, MAX_NAME);
  if (!next) return;
  await db.update(userTable).set({ name: next }).where(eq(userTable.id, user.id));
  revalidatePath("/", "layout");
}
