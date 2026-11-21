import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/* ─────────────────────────────── enums ─────────────────────────────── */

export const messageRole = pgEnum("message_role", ["user", "assistant", "system"]);
export const messageStatus = pgEnum("message_status", ["pending", "streaming", "complete", "error"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "waiting_input", "done", "error", "canceled"]);
export const endpointKind = pgEnum("endpoint_kind", [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
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
/**
 * Who may use the product without paying and configure it. `owner` is granted
 * only by the server from `OWNER_EMAILS`, never by a request.
 */
export const userRole = pgEnum("user_role", ["owner", "member"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ──────────────────────────── better-auth ──────────────────────────── */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /**
   * Defaults to `member`, so a self-serve signup can never grant itself access.
   * `syncOwnerRoles` is the only writer of `owner`, driven by `OWNER_EMAILS`.
   */
  role: userRole("role").notNull().default("member"),
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
    /**
     * The built-in this row is, from `BUILTIN_PROVIDERS` in `@terabot/providers`;
     * null for a custom endpoint. Its base URL comes from that table rather than
     * from `baseUrl` below, so a moved provider is one code change and not a
     * migration of every saved row.
     */
    builtinId: text("builtin_id"),
    /** USD per 1M tokens the user set, or that the catalogue filled. */
    pricing: jsonb("pricing").$type<{
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }>(),
    /** Whether the model accepts tools; null until set or filled. */
    toolSupport: boolean("tool_support"),
    /** Whether the model reasons before answering; null until set or filled. */
    reasoningCapability: boolean("reasoning_capability"),
    /** Fields in this row that the catalogue filled rather than the user. */
    autoFilledFields: jsonb("auto_filled_fields").$type<string[]>(),
    /** Last `GET /models` answer from the endpoint itself, cached for the picker. */
    modelList: jsonb("model_list").$type<Array<{ id: string; ownedBy?: string; created?: number }>>(),
    modelListFetchedAt: timestamp("model_list_fetched_at", { withTimezone: true }),
    /** An `ETag` from the same call, so the next refresh can be a conditional GET. */
    modelListEtag: text("model_list_etag"),
    createdAt: createdAt(),
  },
  (t) => [index("model_endpoint_workspace_idx").on(t.workspaceId)],
);

/* ───────────────────────────── computers ───────────────────────────── */

export const computerAccount = pgTable(
  "computer_account",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    status: computerAccountStatus("status").notNull().default("active"),
    capacity: integer("capacity").notNull().default(1),
    /**
     * True when the deployment provided this account from its own key, so a
     * user with no plan still gets a computer and no user can edit or delete
     * the row. False for an account a user connected with their own key.
     */
    managed: boolean("managed").notNull().default(false),
    /**
     * Which user connected a non-managed account. Managed rows leave it null.
     * A user's own account always outranks a managed one for their own bots.
     *
     * Set null rather than cascade: deleting a user must not discard the
     * credential needed to reap the boxes still running for them.
     */
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Do not start a box on this account before this instant (rate limits). */
    parkedUntil: timestamp("parked_until", { withTimezone: true }),
    lastError: text("last_error"),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    // One account per provider per user, managed rows exempt. A user may still
    // configure several providers; they just cannot stack up accounts of one.
    uniqueIndex("computer_account_owner_provider_idx")
      .on(t.ownerUserId, t.provider)
      .where(sql`${t.ownerUserId} is not null`),
    // One managed account per provider for the whole deployment.
    uniqueIndex("computer_account_managed_provider_idx")
      .on(t.provider)
      .where(sql`${t.managed}`),
  ],
);

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
    /** The workspace whose bot owns this box; null when its bot is already gone. */
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("computer_account_idx").on(t.accountId),
    index("computer_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * A box the provider still exists but we could not delete.
 *
 * `deleteBot` destroys the box through the provider before it removes the row.
 * When that call fails, the bot deletion still completes — a user must not be
 * stuck with a bot they asked to remove — and the box is recorded here with
 * everything needed to delete it later: which provider, which account, which
 * external id. `reapOrphans` retries each one; a row that succeeds is deleted,
 * a row that fails again keeps its attempt count and error so an operator can
 * see what is billing them and why it will not go away.
 */
export const computerOrphan = pgTable(
  "computer_orphan",
  {
    id: uuid("id").primaryKey(),
    /** The account the box was created on; null when that row is already gone. */
    accountId: uuid("account_id").references(() => computerAccount.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    /** The provider's own box id: the only handle a later destroy needs. */
    externalId: text("external_id").notNull(),
    /** Why it is here: `bot-delete` or `workspace-delete`. */
    reason: text("reason").notNull(),
    /** The bot the box belonged to, kept for a human reading the row. */
    botId: uuid("bot_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("computer_orphan_provider_idx").on(t.provider, t.externalId),
    index("computer_orphan_attempt_idx").on(t.lastAttemptAt),
  ],
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

/* ──────────────────────────────── vault ────────────────────────────── */

export const vaultItemKind = pgEnum("vault_item_kind", ["login", "card", "contact"]);

/**
 * One row per stored credential, whichever kind it is.
 *
 * A single table with a typed payload rather than one table per kind: the three
 * kinds share everything that matters for safety — the workspace scope, the
 * owner, the domain the value belongs to, the encryption and the last-used
 * timestamp — and differ only in which fields exist. Those differences live in
 * the kind definitions in `@terabot/vault`, so adding a kind is a new definition
 * rather than a migration, and there is exactly one code path that encrypts.
 *
 * `secrets` holds ciphertext only: `{ password: "v1:iv:tag:ct", … }`, produced by
 * `encryptSecret` (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`). `meta` holds the
 * fields the list may show in the clear, and `hint` is a writer-computed masked
 * tail ("•••• 4242") so rendering a list never decrypts anything.
 */
export const vaultItem = pgTable(
  "vault_item",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The person whose vault this is; every read is scoped to them. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: vaultItemKind("kind").notNull(),
    label: text("label").notNull(),
    /** Hostname the item is for ("github.com"); a fill to another host is refused. */
    domain: text("domain"),
    /** Masked tail for lists: never a secret, never decrypted at read time. */
    hint: text("hint"),
    meta: jsonb("meta").$type<Record<string, string>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vault_item_workspace_idx").on(t.workspaceId, t.kind),
    index("vault_item_owner_idx").on(t.userId),
    index("vault_item_domain_idx").on(t.workspaceId, t.domain),
  ],
);

/* ──────────────────────── skills and routines ──────────────────────── */

/**
 * An unanswered request from a bot for a credential it cannot obtain itself.
 *
 * The row holds no secret ever: `status` is the whole answer, and the value a
 * person submits travels either into `vault_item` (saved) or into the submitting
 * process's memory for one run (not saved). What lives here is the question and
 * its lifecycle, so the card survives a page reload and can expire.
 */
export const secretRequestStatus = pgEnum("secret_request_status", [
  "pending",
  "provided",
  "declined",
  "expired",
]);

export const secretRequest = pgTable(
  "secret_request",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    kind: vaultItemKind("kind").notNull(),
    /** The bot's own words for why it needs this, shown on the card. */
    reason: text("reason").notNull(),
    /** Which fields to collect: a closed set from the kind definition. */
    fields: jsonb("fields").$type<string[]>().notNull().default([]),
    status: secretRequestStatus("status").notNull().default("pending"),
    /** The vault item created when the person kept the "Save to vault" default. */
    vaultItemId: uuid("vault_item_id").references(() => vaultItem.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("secret_request_run_idx").on(t.runId),
    index("secret_request_pending_idx").on(t.conversationId, t.status),
  ],
);

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
    /**
     * Set on upload, before any message names the file: it is what makes an
     * unclaimed upload claimable by its own workspace and by no other.
     */
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    mime: text("mime").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId), index("attachment_workspace_idx").on(t.workspaceId)],
);

/**
 * Attachment bytes when no S3-compatible bucket is configured. The key is the
 * attachment id, so the bytes cascade with the row that names them.
 */
export const attachmentBlob = pgTable("attachment_blob", {
  attachmentId: uuid("attachment_id")
    .primaryKey()
    .references(() => attachment.id, { onDelete: "cascade" }),
  bytes: bytea("bytes").notNull(),
  createdAt: createdAt(),
});

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
    /** USD for this call; null when the catalogue has no price for the model. */
    cost: numeric("cost", { precision: 12, scale: 6 }),
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
  vaultItem,
  secretRequest,
  skill,
  routine,
  attachment,
  attachmentBlob,
  usageEvent,
};
