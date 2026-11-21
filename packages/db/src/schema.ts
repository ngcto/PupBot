import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ─────────────────────────────── enums ─────────────────────────────── */

export const messageRole = pgEnum("message_role", ["user", "assistant", "system"]);
export const messageStatus = pgEnum("message_status", ["pending", "streaming", "complete", "error"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "waiting_input", "done", "error", "canceled"]);
export const endpointKind = pgEnum("endpoint_kind", [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "chatgpt-oauth",
]);
export const computerStatus = pgEnum("computer_status", [
  "provisioning",
  "awake",
  "asleep",
  "waking",
  "error",
  "deleted",
]);
export const computerAccountStatus = pgEnum("computer_account_status", ["active", "draining", "error"]);
export const catalogMatch = pgEnum("catalog_match", ["matched", "unmatched", "manual"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ──────────────────────────── better-auth ──────────────────────────── */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ────────────────────────────── tenancy ────────────────────────────── */

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspace_owner_idx").on(t.ownerId)],
);

/* ──────────────────────────────── bots ─────────────────────────────── */

export const botSection = pgTable(
  "bot_section",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("bot_section_workspace_idx").on(t.workspaceId, t.position)],
);

export const bot = pgTable(
  "bot",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    avatar: jsonb("avatar").$type<{ shape: string; color: string }>().notNull(),
    accentColor: text("accent_color").notNull(),
    instructions: text("instructions").notNull().default(""),
    modelEndpointId: uuid("model_endpoint_id"),
    modelId: text("model_id"),
    sectionId: uuid("section_id").references(() => botSection.id, { onDelete: "set null" }),
    pinned: boolean("pinned").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    unread: boolean("unread").notNull().default(false),
    status: text("status").notNull().default("active"),
    /** unbound | binding | ready | blocked: what the composer reads. */
    computerState: text("computer_state").notNull().default("unbound"),
    /** Why chat is blocked, in words the UI shows verbatim. */
    computerReason: text("computer_reason"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bot_workspace_idx").on(t.workspaceId, t.position),
    index("bot_section_idx").on(t.sectionId),
  ],
);

export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    title: text("title"),
    lastMessagePreview: text("last_message_preview"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversation_bot_idx").on(t.botId), index("conversation_primary_idx").on(t.isPrimary)],
);

/* ──────────────────────────── conversations ────────────────────────── */

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; attachmentId?: string; name: string; size: number; mime: string }
  | { type: "image"; attachmentId?: string; name: string; mime: string; url?: string }
  | { type: "quote"; messageId: string; text: string };

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    role: messageRole("role").notNull(),
    parts: jsonb("parts").$type<MessagePart[]>().notNull().default([]),
    status: messageStatus("status").notNull().default("complete"),
    createdAt: createdAt(),
  },
  (t) => [index("message_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("queued"),
    abortRequested: boolean("abort_requested").notNull().default(false),
    stepCount: integer("step_count").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cost: numeric("cost", { precision: 12, scale: 6 }),
    model: text("model"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("run_conversation_idx").on(t.conversationId, t.createdAt), index("run_status_idx").on(t.status)],
);

export const runEvent = pgTable(
  "run_event",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("run_event_run_seq_idx").on(t.runId, t.seq)],
);

export const toolCall = pgTable(
  "tool_call",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("tool_call_run_idx").on(t.runId)],
);

/* ────────────────────────── models and catalog ─────────────────────── */

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    contextWindow: integer("context_window"),
    maxOutput: integer("max_output"),
    pricing: jsonb("pricing").$type<{
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }>(),
    modalities: jsonb("modalities").$type<{ input?: string[]; output?: string[] }>(),
    toolSupport: boolean("tool_support").notNull().default(false),
    reasoning: boolean("reasoning").notNull().default(false),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("model_catalog_provider_model_idx").on(t.provider, t.modelId)],
);

export const modelEndpoint = pgTable(
  "model_endpoint",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: endpointKind("kind").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    modelId: text("model_id").notNull(),
    encryptedKey: text("encrypted_key"),
    modelCatalogId: uuid("model_catalog_id").references(() => modelCatalog.id, { onDelete: "set null" }),
    catalogMatch: catalogMatch("catalog_match").notNull().default("unmatched"),
    contextWindow: integer("context_window"),
    createdAt: createdAt(),
  },
  (t) => [index("model_endpoint_workspace_idx").on(t.workspaceId)],
);

/* ───────────────────────────── computers ───────────────────────────── */

export const computerAccount = pgTable("computer_account", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  encryptedCredential: text("encrypted_credential").notNull(),
  status: computerAccountStatus("status").notNull().default("active"),
  capacity: integer("capacity").notNull().default(1),
  /** Do not start a box on this account before this instant (rate limits). */
  parkedUntil: timestamp("parked_until", { withTimezone: true }),
  lastError: text("last_error"),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

export const computer = pgTable(
  "computer",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").references(() => computerAccount.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    status: computerStatus("status").notNull().default("provisioning"),
    specs: jsonb("specs").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
  },
  (t) => [index("computer_account_idx").on(t.accountId)],
);

export const computerLease = pgTable(
  "computer_lease",
  {
    id: text("id").primaryKey(),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computer.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("computer_lease_computer_idx").on(t.computerId, t.expiresAt)],
);

export const botComputer = pgTable(
  "bot_computer",
  {
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computer.id, { onDelete: "cascade" }),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    index("bot_computer_bot_idx").on(t.botId),
    uniqueIndex("bot_computer_active_idx")
      .on(t.botId)
      .where(sql`${t.releasedAt} is null`),
  ],
);

/* ────────────────────────── apps (Composio) ────────────────────────── */

/**
 * A connected app account, one row per end user and toolkit.
 *
 * The row holds a reference, never a credential: Composio stores the OAuth
 * tokens or the user's API key and refreshes them, and we keep the connected
 * account id plus the auth config it was created against. That is exactly the
 * pair Composio's execution API needs later, so wiring tools into a run is an
 * addition rather than a migration. Moving from Composio-managed credentials to
 * our own per-toolkit OAuth app also changes no column: only which auth config
 * a new connection is created against.
 */
export const appConnectionStatus = pgEnum("app_connection_status", ["pending", "active", "error"]);

export const appConnection = pgTable(
  "app_connection",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The person who authorized it; every read is scoped to this. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    toolkit: text("toolkit").notNull(),
    /** The app's display name when it was connected, so a list never needs the catalog. */
    name: text("name").notNull(),
    composioAccountId: text("composio_account_id").notNull(),
    authConfigId: text("auth_config_id").notNull(),
    status: appConnectionStatus("status").notNull().default("pending"),
    /** Composio's own status word (INITIALIZING, INITIATED, ACTIVE, ...) as last read. */
    statusDetail: text("status_detail"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("app_connection_account_idx").on(t.composioAccountId),
    index("app_connection_user_idx").on(t.userId, t.status),
    index("app_connection_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * Which connected apps a bot may use. Nothing reads this during a run yet —
 * the harness has no tool loop — so it is a stored choice, and the UI says so.
 */
export const botApp = pgTable(
  "bot_app",
  {
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => appConnection.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bot_app_bot_connection_idx").on(t.botId, t.connectionId),
    index("bot_app_connection_idx").on(t.connectionId),
  ],
);

/* ──────────────────────── skills and routines ──────────────────────── */

export const skill = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt"),
    toolRefs: jsonb("tool_refs").$type<string[]>(),
    source: text("source").notNull().default("builtin"),
    createdAt: createdAt(),
  },
  (t) => [index("skill_workspace_idx").on(t.workspaceId)],
);

export const routine = pgTable(
  "routine",
  {
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("routine_bot_idx").on(t.botId)],
);

/* ───────────────────────── attachments and usage ───────────────────── */

export const attachment = pgTable(
  "attachment",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    mime: text("mime").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

export const usageEvent = pgTable(
  "usage_event",
  {
    id: uuid("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cost: numeric("cost", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_bot_idx").on(t.botId, t.createdAt)],
);

export const schema = {
  user,
  session,
  account,
  verification,
  workspace,
  botSection,
  bot,
  conversation,
  message,
  run,
  runEvent,
  toolCall,
  modelCatalog,
  modelEndpoint,
  computerAccount,
  computer,
  computerLease,
  botComputer,
  appConnection,
  botApp,
  skill,
  routine,
  attachment,
  usageEvent,
};
