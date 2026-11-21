import {
  bot as botTable,
  botApp,
  botComputer,
  botSection,
  computer,
  conversation,
  database,
  message,
  modelEndpoint,
  run,
  usageEvent,
} from "@terabot/db";
import { providerHintForBaseUrl } from "@terabot/providers";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { listConnectionsFor } from "./apps.ts";
import { listComputerAccounts, providerAvailability } from "./computer-accounts.ts";
import type {
  BotView,
  ConnectedApp,
  EndpointView,
  MessageView,
  SectionView,
  ShellData,
  ShellUser,
  UsageView,
} from "./types.ts";

function botQuery(workspaceId: string) {
  const db = database();
  return db
    .select({
      id: botTable.id,
      name: botTable.name,
      avatar: botTable.avatar,
      accentColor: botTable.accentColor,
      instructions: botTable.instructions,
      pinned: botTable.pinned,
      hidden: botTable.hidden,
      unread: botTable.unread,
      sectionId: botTable.sectionId,
      position: botTable.position,
      modelEndpointId: botTable.modelEndpointId,
      conversationId: conversation.id,
      lastMessagePreview: conversation.lastMessagePreview,
      isPrimary: conversation.isPrimary,
      computerId: computer.id,
      computerExternalId: computer.externalId,
      computerProvider: computer.provider,
      computerStatus: computer.status,
      computerState: botTable.computerState,
      computerReason: botTable.computerReason,
    })
    .from(botTable)
    .leftJoin(conversation, eq(conversation.botId, botTable.id))
    .leftJoin(
      botComputer,
      and(eq(botComputer.botId, botTable.id), isNull(botComputer.releasedAt)),
    )
    .leftJoin(computer, eq(computer.id, botComputer.computerId))
    .where(eq(botTable.workspaceId, workspaceId))
    .orderBy(asc(botTable.position), asc(botTable.createdAt));
}

type BotRow = Awaited<ReturnType<typeof botQuery>>[number];

function toBotView(row: BotRow): BotView {
  return {
    id: row.id,
    name: row.name,
    shape: row.avatar.shape,
    color: row.avatar.color,
    accentColor: row.accentColor,
    instructions: row.instructions,
    pinned: row.pinned,
    hidden: row.hidden,
    unread: row.unread,
    sectionId: row.sectionId,
    position: row.position,
    conversationId: row.conversationId ?? "",
    lastMessagePreview: row.lastMessagePreview,
    isPrimary: row.isPrimary ?? false,
    computer: {
      id: row.computerId,
      externalId: row.computerExternalId,
      provider: row.computerProvider,
      status: row.computerStatus,
      binding: (row.computerState as BotView["computer"]["binding"]) ?? "unbound",
      reason: row.computerReason,
    },
    endpointId: row.modelEndpointId,
    appIds: [],
  };
}

export async function loadShellData(input: {
  user: ShellUser;
  workspaceId: string;
  apiUrl: string;
  activeBotId?: string;
}): Promise<ShellData> {
  const db = database();
  const rows = (await botQuery(input.workspaceId)).filter((row) => row.conversationId);
  const bots = rows.map(toBotView);

  const sections: SectionView[] = await db
    .select({ id: botSection.id, name: botSection.name })
    .from(botSection)
    .where(eq(botSection.workspaceId, input.workspaceId))
    .orderBy(asc(botSection.position));

  const activeBot =
    bots.find((entry) => entry.id === input.activeBotId) ??
    bots.find((entry) => entry.isPrimary) ??
    bots[0] ??
    null;

  let messages: MessageView[] = [];
  let activeRunId: string | null = null;

  if (activeBot) {
    const [messageRows, runRows] = await Promise.all([
      db
        .select()
        .from(message)
        .where(eq(message.conversationId, activeBot.conversationId))
        .orderBy(asc(message.createdAt)),
      db
        .select({ id: run.id })
        .from(run)
        .where(and(eq(run.conversationId, activeBot.conversationId), inArray(run.status, ["queued", "running"])))
        .orderBy(desc(run.createdAt))
        .limit(1),
    ]);

    messages = messageRows.map((row) => ({
      id: row.id,
      role: row.role,
      parts: row.parts,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      runId: row.runId,
    }));
    activeRunId = runRows[0]?.id ?? null;
  }

  const endpointRows = await db
    .select({
      id: modelEndpoint.id,
      label: modelEndpoint.label,
      kind: modelEndpoint.kind,
      // Settings > Providers shows this so a custom gateway is identifiable; it
      // is the workspace's own row, never another tenant's.
      baseUrl: modelEndpoint.baseUrl,
      modelId: modelEndpoint.modelId,
      contextWindow: modelEndpoint.contextWindow,
      catalogMatch: modelEndpoint.catalogMatch,
      modelList: modelEndpoint.modelList,
      // Only whether a key exists. The key never leaves the server.
      hasKey: sql<boolean>`${modelEndpoint.encryptedKey} is not null`,
    })
    .from(modelEndpoint)
    .where(eq(modelEndpoint.workspaceId, input.workspaceId))
    .orderBy(asc(modelEndpoint.createdAt));

  const endpoints: EndpointView[] = endpointRows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    contextWindow: row.contextWindow,
    catalogMatch: row.catalogMatch,
    modelCount: row.modelList?.length ?? null,
    hasKey: row.hasKey,
    providerHint: providerHintForBaseUrl(row.baseUrl) ?? null,
  }));

  const usage: UsageView[] = [];
  if (bots.length > 0) {
    const usageRows = await db
      .select({
        botId: usageEvent.botId,
        inputTokens: sql<string>`coalesce(sum(${usageEvent.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${usageEvent.outputTokens}), 0)`,
        cost: sql<string | null>`sum(${usageEvent.cost})`,
        calls: sql<string>`count(*)`,
        unpricedCalls: sql<string>`count(*) filter (where ${usageEvent.cost} is null)`,
      })
      .from(usageEvent)
      .where(inArray(usageEvent.botId, bots.map((bot) => bot.id)))
      .groupBy(usageEvent.botId);

    for (const row of usageRows) {
      usage.push({
        botId: row.botId,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costUsd: row.cost === null ? null : Number(row.cost),
        calls: Number(row.calls),
        unpricedCalls: Number(row.unpricedCalls),
      });
    }
  }

  // Every bot, not only the active one: settings can be opened for a bot from the
  // sidebar without switching to it, and an empty list would read as "nothing granted"
  // for a bot that has grants. One query for all of them.
  if (bots.length > 0) {
    const appRows = await db
      .select({ botId: botApp.botId, connectionId: botApp.connectionId })
      .from(botApp)
      .where(
        inArray(
          botApp.botId,
          bots.map((bot) => bot.id),
        ),
      );
    const byBot = new Map<string, string[]>();
    for (const row of appRows) {
      const list = byBot.get(row.botId);
      if (list) list.push(row.connectionId);
      else byBot.set(row.botId, [row.connectionId]);
    }
    for (const bot of bots) bot.appIds = byBot.get(bot.id) ?? [];
  }

  const connections: ConnectedApp[] = await listConnectionsFor(input.user.id);

  return {
    user: input.user,
    apiUrl: input.apiUrl,
    bots,
    sections,
    activeBot,
    messages,
    activeRunId,
    endpoints,
    usage,
    connections,
    computerAccounts: await listComputerAccounts(input.user.id),
    computerProviders: await providerAvailability(input.user.id),
  };
}
