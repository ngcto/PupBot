import { eq } from "drizzle-orm";
import { asc, desc } from "drizzle-orm";
import {
  bot as botTable,
  conversation as conversationTable,
  decryptSecret,
  message as messageTable,
  modelEndpoint,
  newId,
  run as runTable,
  runEvent,
  usageEvent,
} from "@pupbot/db";
import type { Database, MessagePart } from "@pupbot/db";
import { gatewayCredential, serverEnv } from "@pupbot/config";
import type { ModelEndpointConfig, ModelGateway } from "@pupbot/providers";
import { buildChatContext } from "./context.ts";
import type { RunStreamEvent } from "./events.ts";
import { STEP_ROTATE_MS, stepLabel } from "./steps.ts";

export interface ResolvedEndpoint {
  config: ModelEndpointConfig;
  label: string;
}

export interface ExecuteRunOptions {
  db: Database;
  gateway: ModelGateway;
  runId: string;
  /** How often the in-flight run checks `run.abort_requested`. */
  abortPollMs?: number;
  signal?: AbortSignal;
  resolveEndpoint?: (botRow: BotRow) => Promise<ResolvedEndpoint | null>;
  now?: () => Date;
}

export interface BotRow {
  id: string;
  name: string;
  instructions: string;
  modelEndpointId: string | null;
  modelId: string | null;
}

export interface RunOutcome {
  status: "done" | "canceled" | "error";
  assistantMessageId: string | null;
  text: string;
  error?: string;
}

const CONTEXT_LIMIT = 40;
const FLUSH_MS = 90;
const FLUSH_CHARS = 120;

class EventLog {
  #seq = 0;
  readonly #db: Database;
  readonly #runId: string;

  constructor(db: Database, runId: string) {
    this.#db = db;
    this.#runId = runId;
  }

  async primeFromDatabase(): Promise<void> {
    const rows = await this.#db
      .select({ seq: runEvent.seq })
      .from(runEvent)
      .where(eq(runEvent.runId, this.#runId))
      .orderBy(desc(runEvent.seq))
      .limit(1);
    this.#seq = rows[0]?.seq ?? 0;
  }

  async append(event: RunStreamEvent): Promise<number> {
    this.#seq += 1;
    await this.#db.insert(runEvent).values({
      id: newId(),
      runId: this.#runId,
      seq: this.#seq,
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    });
    return this.#seq;
  }
}

async function gatewayKeyFor(baseUrl: string): Promise<string | undefined> {
  const env = serverEnv();
  const normalise = (value: string) => value.replace(/\/+$/, "");
  if (normalise(baseUrl) !== normalise(env.AI_GATEWAY_BASE_URL)) return undefined;
  return gatewayCredential(env);
}

function textParts(text: string): MessagePart[] {
  return [{ type: "text", text }];
}

async function defaultResolveEndpoint(db: Database, botRow: BotRow): Promise<ResolvedEndpoint | null> {
  if (!botRow.modelEndpointId) return null;
  const rows = await db
    .select()
    .from(modelEndpoint)
    .where(eq(modelEndpoint.id, botRow.modelEndpointId))
    .limit(1);
  const endpoint = rows[0];
  if (!endpoint) return null;

  let apiKey: string | undefined;
  if (endpoint.encryptedKey) {
    try {
      apiKey = decryptSecret(endpoint.encryptedKey);
    } catch {
      apiKey = undefined;
    }
  }
  // The AI Gateway endpoint ships with no stored key: the deployment's own
  // OIDC token (or an explicit AI_GATEWAY_API_KEY) authenticates the request.
  apiKey ??= await gatewayKeyFor(endpoint.baseUrl);

  return {
    label: endpoint.label,
    config: {
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      model: botRow.modelId ?? endpoint.modelId,
      apiKey,
    },
  };
}

/**
 * One run: assemble context, stream the model through the gateway, and append
 * every delta to `run_event` so a reconnect replays what it missed. Aborting is
 * cooperative: `abort_requested` flips the signal, the partial text is kept as a
 * finished assistant message, and the run ends `canceled`.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<RunOutcome> {
  const { db, gateway, runId } = options;
  const abortPollMs = options.abortPollMs ?? 120;
  const now = options.now ?? (() => new Date());

  const rows = await db
    .select({ run: runTable, bot: botTable, conversation: conversationTable })
    .from(runTable)
    .innerJoin(botTable, eq(runTable.botId, botTable.id))
    .innerJoin(conversationTable, eq(runTable.conversationId, conversationTable.id))
    .where(eq(runTable.id, runId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`run ${runId} not found`);

  const events = new EventLog(db, runId);
  await events.primeFromDatabase();

  if (row.run.status === "done" || row.run.status === "canceled" || row.run.status === "error") {
    return { status: row.run.status, assistantMessageId: null, text: "" };
  }

  if (row.run.abortRequested) {
    await events.append({ type: "run.completed", payload: { status: "canceled" } });
    await setRunTerminal(db, { runId, status: "canceled", finishedAt: now() });
    return { status: "canceled", assistantMessageId: null, text: "" };
  }

  await db
    .update(runTable)
    .set({ status: "running", startedAt: row.run.startedAt ?? now() })
    .where(eq(runTable.id, runId));

  const resolveEndpoint = options.resolveEndpoint
    ? (botRow: BotRow) => options.resolveEndpoint!(botRow)
    : (botRow: BotRow) => defaultResolveEndpoint(db, botRow);

  const resolved = await resolveEndpoint({
    id: row.bot.id,
    name: row.bot.name,
    instructions: row.bot.instructions,
    modelEndpointId: row.bot.modelEndpointId,
    modelId: row.bot.modelId,
  });

  const history = await db
    .select()
    .from(messageTable)
    .where(eq(messageTable.conversationId, row.conversation.id))
    .orderBy(desc(messageTable.createdAt))
    .limit(CONTEXT_LIMIT);
  history.reverse();

  const assistantMessageId = newId();
  await db.insert(messageTable).values({
    id: assistantMessageId,
    conversationId: row.conversation.id,
    runId,
    role: "assistant",
    parts: textParts(""),
    status: "streaming",
  });

  await events.append({ type: "run.started", payload: { runId, messageId: assistantMessageId } });

  if (!resolved) {
    const reason = "No model endpoint is connected to this bot.";
    await finishMessage(db, { messageId: assistantMessageId, text: "", status: "error" });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text: "", status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: reason } });
    await setRunTerminal(db, { runId, status: "error", error: reason, finishedAt: now() });
    return { status: "error", assistantMessageId, text: "", error: reason };
  }

  const context = buildChatContext(row.bot, history);

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let canceled = false;
  const poll = setInterval(() => {
    void (async () => {
      if (controller.signal.aborted) return;
      const current = await db
        .select({ abortRequested: runTable.abortRequested })
        .from(runTable)
        .where(eq(runTable.id, runId))
        .limit(1);
      if (current[0]?.abortRequested) {
        canceled = true;
        controller.abort();
      }
    })().catch(() => {});
  }, abortPollMs);

  let text = "";
  let reasoning = "";
  let pendingText = "";
  let pendingReasoning = "";
  let lastFlush = Date.now();
  let sawToken = false;
  let stepIndex = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let failure: string | undefined;

  const rotate = setInterval(() => {
    if (sawToken || controller.signal.aborted) return;
    void events
      .append({ type: "step", payload: { label: stepLabel(++stepIndex) } })
      .catch(() => {});
  }, STEP_ROTATE_MS);

  const flush = async (force = false) => {
    if (!pendingText && !pendingReasoning && !force) return;
    if (!force && pendingText.length < FLUSH_CHARS && Date.now() - lastFlush < FLUSH_MS) return;
    const textDelta = pendingText;
    const reasoningDelta = pendingReasoning;
    pendingText = "";
    pendingReasoning = "";
    lastFlush = Date.now();

    if (textDelta) {
      await db
        .update(messageTable)
        .set({ parts: textParts(text) })
        .where(eq(messageTable.id, assistantMessageId));
      await events.append({ type: "text_delta", payload: { text: textDelta } });
    }
    if (reasoningDelta) {
      await events.append({ type: "reasoning_delta", payload: { text: reasoningDelta } });
    }
  };

  try {
    const stream = gateway.stream({
      endpoint: resolved.config,
      messages: context,
      signal: controller.signal,
    });

    for await (const event of stream) {
      if (controller.signal.aborted) break;

      if (event.type === "text_delta") {
        sawToken = true;
        text += event.text;
        pendingText += event.text;
        await flush();
      } else if (event.type === "reasoning_delta") {
        reasoning += event.text;
        pendingReasoning += event.text;
        await flush();
      } else if (event.type === "usage") {
        inputTokens = event.inputTokens ?? inputTokens;
        outputTokens = event.outputTokens ?? outputTokens;
        await events.append({ type: "usage", payload: { inputTokens, outputTokens } });
      } else if (event.type === "error") {
        failure = event.message;
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failure = error instanceof Error ? error.message : "the model stream failed";
    }
  } finally {
    clearInterval(poll);
    clearInterval(rotate);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  await flush(true).catch(() => {});

  const status: RunOutcome["status"] = canceled ? "canceled" : failure ? "error" : "done";

  if (status === "error") {
    await finishMessage(db, { messageId: assistantMessageId, text, status: text ? "complete" : "error" });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text, status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: failure } });
    await setRunTerminal(db, { runId, status: "error", error: failure ?? "unknown error", finishedAt: now() });
    return { status, assistantMessageId, text, error: failure };
  }

  await finishMessage(db, { messageId: assistantMessageId, text, status: "complete" });
  await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text, status: "complete" } });
  await events.append({ type: "run.completed", payload: { status } });
  await setRunTerminal(db, {
    runId,
    status,
    finishedAt: now(),
    inputTokens,
    outputTokens,
    model: resolved.config.model,
  });

  await db
    .update(conversationTable)
    .set({ lastMessagePreview: text.slice(0, 160), updatedAt: now() })
    .where(eq(conversationTable.id, row.conversation.id));

  if (inputTokens || outputTokens) {
    await db.insert(usageEvent).values({
      id: newId(),
      botId: row.bot.id,
      runId,
      model: resolved.config.model,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    });
  }

  void reasoning;
  return { status, assistantMessageId, text };
}

async function finishMessage(
  db: Database,
  input: { messageId: string; text: string; status: "complete" | "error" },
): Promise<void> {
  await db
    .update(messageTable)
    .set({ parts: textParts(input.text), status: input.status })
    .where(eq(messageTable.id, input.messageId));
}

/**
 * The run row is what tells a reader nothing more is coming, so it is written
 * after the closing events: a client that sees a terminal status is guaranteed
 * to find `message.completed` and `run.completed` already in the log.
 */
async function setRunTerminal(
  db: Database,
  input: {
    runId: string;
    status: "done" | "canceled" | "error";
    finishedAt: Date;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  },
): Promise<void> {
  await db
    .update(runTable)
    .set({
      status: input.status,
      finishedAt: input.finishedAt,
      ...(input.error ? { error: input.error } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.model ? { model: input.model } : {}),
    })
    .where(eq(runTable.id, input.runId));
}

export async function messagesForContext(db: Database, conversationId: string) {
  return db
    .select()
    .from(messageTable)
    .where(eq(messageTable.conversationId, conversationId))
    .orderBy(asc(messageTable.createdAt));
}
