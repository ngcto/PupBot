import {
  bot as botTable,
  botComputer,
  botSection,
  computer,
  conversation,
  database,
  message,
  modelEndpoint,
  run,
} from "@pupbot/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { BotView, EndpointView, MessageView, ShellData, ShellUser, SectionView } from "./types.ts";

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
      computerProvider: computer.provider,
      computerStatus: computer.status,
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
    computer:
      row.computerId && row.computerProvider && row.computerStatus
        ? { id: row.computerId, provider: row.computerProvider, status: row.computerStatus }
        : null,
    endpointId: row.modelEndpointId,
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

  const endpoints: EndpointView[] = await db
    .select({
      id: modelEndpoint.id,
      label: modelEndpoint.label,
      kind: modelEndpoint.kind,
      modelId: modelEndpoint.modelId,
      contextWindow: modelEndpoint.contextWindow,
      catalogMatch: modelEndpoint.catalogMatch,
    })
    .from(modelEndpoint)
    .where(eq(modelEndpoint.workspaceId, input.workspaceId))
    .orderBy(asc(modelEndpoint.createdAt));

  return {
    user: input.user,
    apiUrl: input.apiUrl,
    bots,
    sections,
    activeBot,
    messages,
    activeRunId,
    endpoints,
  };
}
