import { and, asc, desc, eq } from "drizzle-orm";
import {
  bot as botTable,
  conversation as conversationTable,
  decryptSecret,
  encryptSecret,
  message as messageTable,
  modelCatalog,
  modelEndpoint,
  newId,
  run as runTable,
  runEvent,
  usageEvent,
} from "@terabot/db";
import type { Database, MessagePart } from "@terabot/db";
import { costAsDecimal, costOf, providerHintForBaseUrl } from "@terabot/providers";
import type { ModelEndpointConfig, ModelGateway, ModelPricing } from "@terabot/providers";
import { buildChatContext } from "./context.ts";
import type { RunStreamEvent } from "./events.ts";
import { STEP_ROTATE_MS, stepLabel } from "./steps.ts";

export interface ResolvedEndpoint {
  config: ModelEndpointConfig;
  label: string;
  /** USD per 1M tokens from `model_catalog`; null when the model is unmatched. */
  pricing?: ModelPricing | null;
}

/** What the harness needs from the computer layer: wake before the first token. */
export interface RunComputer {
  ensureReady: (botId: string) => Promise<{
    ok: boolean;
    reason?: string;
    blocked?: boolean;
    leaseId?: string;
    woke?: boolean;
  }>;
  release: (botId: string, leaseId: string) => Promise<void>;
}

export interface ExecuteRunOptions {
  db: Database;
  gateway: ModelGateway;
  runId: string;
  /** How often the in-flight run checks `run.abort_requested`. */
  abortPollMs?: number;
  signal?: AbortSignal;
  /** Wakes the bot's computer before the model runs; chat is blocked without one. */
  computer?: RunComputer;
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

function textParts(text: string): MessagePart[] {
  return [{ type: "text", text }];
}

async function pricingForModel(
  db: Database,
  endpoint: { modelCatalogId: string | null; baseUrl: string },
  model: string,
): Promise<ModelPricing | null> {
  if (endpoint.modelCatalogId) {
    const rows = await db
      .select({ pricing: modelCatalog.pricing, modelId: modelCatalog.modelId })
      .from(modelCatalog)
      .where(eq(modelCatalog.id, endpoint.modelCatalogId))
      .limit(1);
    if (rows[0]?.modelId === model && rows[0]?.pricing) return rows[0].pricing;
  }

  const hint = providerHintForBaseUrl(endpoint.baseUrl);
  const rows = await db
    .select({ pricing: modelCatalog.pricing, provider: modelCatalog.provider })
    .from(modelCatalog)
    .where(
      hint
        ? and(eq(modelCatalog.modelId, model), eq(modelCatalog.provider, hint))
        : eq(modelCatalog.modelId, model),
    )
    .limit(20);
  const priced = rows.filter((row) => row.pricing);
  return priced[0]?.pricing ?? null;
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

  const model = botRow.modelId ?? endpoint.modelId;
  let apiKey: string | undefined;
  if (endpoint.encryptedKey) {
    try {
      apiKey = decryptSecret(endpoint.encryptedKey);
    } catch {
      apiKey = undefined;
    }
  }

  return {
    label: endpoint.label,
    pricing: await pricingForModel(db, endpoint, model),
    config: {
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      model,
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
    await finishRun(db, runId, "canceled", { now });
    await events.append({ type: "run.completed", payload: { status: "canceled" } });
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

  // A retried run reuses the assistant message the earlier attempt left behind,
  // so a redelivered job never leaves a second streaming bubble in the thread.
  const priorAssistant = (
    await db
      .select({ id: messageTable.id })
      .from(messageTable)
      .where(and(eq(messageTable.runId, runId), eq(messageTable.role, "assistant")))
      .orderBy(desc(messageTable.createdAt))
      .limit(1)
  )[0];
  const assistantMessageId = priorAssistant?.id ?? newId();
  if (priorAssistant) {
    await db
      .update(messageTable)
      .set({ parts: textParts(""), status: "streaming" })
      .where(eq(messageTable.id, assistantMessageId));
  } else {
    await db.insert(messageTable).values({
      id: assistantMessageId,
      conversationId: row.conversation.id,
      runId,
      role: "assistant",
      parts: textParts(""),
      status: "streaming",
    });
  }

  await events.append({ type: "run.started", payload: { runId, messageId: assistantMessageId } });

  if (!resolved) {
    const reason = "No model endpoint is connected to this bot.";
    await failRun(db, {
      runId,
      messageId: assistantMessageId,
      text: "",
      reason,
      now,
    });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text: "", status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: reason } });
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
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let failure: string | undefined;
  let rotate: ReturnType<typeof setInterval> | undefined;


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

  let leaseId: string | undefined;

  try {
    // Wake on first use, explicitly: Instabox refuses exec on a paused box and
    // does not wake it, so the run shows what is happening instead of a spinner.
    if (options.computer) {
      await events.append({ type: "step", payload: { label: "Waking your computer" } });
      const ready = await options.computer.ensureReady(row.bot.id);
      if (!ready.ok) {
        const reason = ready.reason ?? "Your computer could not be started.";
        await failRun(db, { runId, messageId: assistantMessageId, text: "", reason, now });
        await events.append({
          type: "message.completed",
          payload: { messageId: assistantMessageId, text: "", status: "error" },
        });
        await events.append({ type: "run.completed", payload: { status: "error", error: reason } });
        return { status: "error", assistantMessageId, text: "", error: reason };
      }
      leaseId = ready.leaseId;
    }

    rotate = setInterval(() => {
      if (sawToken || controller.signal.aborted) return;
      void events
        .append({ type: "step", payload: { label: stepLabel(++stepIndex) } })
        .catch(() => {});
    }, STEP_ROTATE_MS);

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
        cacheReadTokens = event.cacheReadTokens ?? cacheReadTokens;
        cacheWriteTokens = event.cacheWriteTokens ?? cacheWriteTokens;
        await events.append({
          type: "usage",
          payload: {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
          },
        });
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
    if (rotate) clearInterval(rotate);
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (options.computer && leaseId) {
      await options.computer.release(row.bot.id, leaseId).catch(() => undefined);
    }
  }

  await flush(true).catch(() => {});

  const cost = costOf(resolved.pricing ?? null, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
  const costText = cost === null ? null : costAsDecimal(cost);

  if (inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens) {
    await db.insert(usageEvent).values({
      id: newId(),
      botId: row.bot.id,
      runId,
      model: resolved.config.model,
      inputTokens: (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
      outputTokens: outputTokens ?? 0,
      cost: costText,
    });
  }

  // An external abort (shutdown, job cancellation) is a cancellation, not a
  // complete answer, so the run is not saved as done.
  const status: RunOutcome["status"] =
    canceled || options.signal?.aborted ? "canceled" : failure ? "error" : "done";

  if (status === "error") {
    await failRun(db, {
      runId,
      messageId: assistantMessageId,
      text,
      reason: failure ?? "unknown error",
      now,
      cost: costText,
    });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text, status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: failure } });
    return { status, assistantMessageId, text, error: failure };
  }

  await db
    .update(messageTable)
    .set({ parts: textParts(text), status: "complete" })
    .where(eq(messageTable.id, assistantMessageId));

  await finishRun(db, runId, status, {
    now,
    inputTokens,
    outputTokens,
    model: resolved.config.model,
    cost: costText,
  });

  await db
    .update(conversationTable)
    .set({ lastMessagePreview: text.slice(0, 160), updatedAt: now() })
    .where(eq(conversationTable.id, row.conversation.id));

  await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text, status: "complete" } });
  await events.append({ type: "run.completed", payload: { status } });

  void reasoning;
  return { status, assistantMessageId, text };
}

async function finishRun(
  db: Database,
  runId: string,
  status: "done" | "canceled",
  extra: {
    now: () => Date;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    cost?: string | null;
  },
): Promise<void> {
  await db
    .update(runTable)
    .set({
      status,
      finishedAt: extra.now(),
      ...(extra.inputTokens !== undefined ? { inputTokens: extra.inputTokens } : {}),
      ...(extra.outputTokens !== undefined ? { outputTokens: extra.outputTokens } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.cost !== undefined ? { cost: extra.cost } : {}),
    })
    .where(eq(runTable.id, runId));
}

async function failRun(
  db: Database,
  input: {
    runId: string;
    messageId: string;
    text: string;
    reason: string;
    now: () => Date;
    cost?: string | null;
  },
): Promise<void> {
  await db
    .update(messageTable)
    .set({ parts: textParts(input.text), status: input.text ? "complete" : "error" })
    .where(eq(messageTable.id, input.messageId));
  await db
    .update(runTable)
    .set({
      status: "error",
      error: input.reason,
      finishedAt: input.now(),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
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
