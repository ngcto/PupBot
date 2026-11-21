import { and, asc, desc, eq } from "drizzle-orm";
import {
  bot as botTable,
  conversation as conversationTable,
  decryptSecret,
  message as messageTable,
  modelCatalog,
  modelEndpoint,
  newId,
  run as runTable,
  runEvent,
  toolCall as toolCallTable,
  usageEvent,
} from "@terabot/db";
import type { Database, MessagePart } from "@terabot/db";
import { gatewayCredential, serverEnv } from "@terabot/config";
import { costAsDecimal, costOf, endpointConfigForRow, providerHintForBaseUrl } from "@terabot/providers";
import type { ModelEndpointConfig, ModelGateway, ModelPricing } from "@terabot/providers";
import { buildChatContext } from "./context.ts";
import type { RunStreamEvent } from "./events.ts";
import { STEP_ROTATE_MS, stepLabel } from "./steps.ts";
import { createToolRegistry, schemasOf, summariseToolError } from "./tools.ts";
import { codemodeTool, isCodeMode } from "./codemode-tool.ts";
import { runCommandTool } from "./run-command.ts";
import type { RunTool, ToolContext } from "./tools.ts";
import { parseToolArguments } from "@terabot/providers";
import type { ChatMessage } from "@terabot/providers";

export interface ResolvedEndpoint {
  config: ModelEndpointConfig;
  label: string;
  /** USD per 1M tokens from `model_catalog`; null when the model is unmatched. */
  pricing?: ModelPricing | null;
}

import type { RunComputer } from "./computer.ts";

/** What the harness needs from the computer layer: a machine for the length of some work. */
export type { RunComputer } from "./computer.ts";

export interface ExecuteRunOptions {
  db: Database;
  gateway: ModelGateway;
  runId: string;
  /** How often the in-flight run checks `run.abort_requested`. */
  abortPollMs?: number;
  signal?: AbortSignal;
  /**
   * The bot's computer, obtained on first use of a tool. Without one, runs are
   * plain chat: a bot that only talks never provisions a machine.
   */
  computer?: RunComputer;
  /**
   * Resolves the endpoint for a bot. `session` is the run's conversation, which
   * a built-in provider that routes per session needs; a caller overriding this
   * hook should pass it through so those providers keep working.
   */
  resolveEndpoint?: (botRow: BotRow, session: string) => Promise<ResolvedEndpoint | null>;
  /**
   * Tools this run may use. A run with none streams a plain answer, exactly as
   * before: the loop is the same code, just with nothing to call.
   */
  tools?: RunTool[];
  now?: () => Date;
}

/** A ceiling on tool steps per message, so a model in a loop cannot bill forever. */
export const MAX_TOOL_STEPS = 8;

interface CollectedCall {
  id: string;
  name: string;
  arguments: string;
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

async function defaultResolveEndpoint(
  db: Database,
  botRow: BotRow,
  session: string,
): Promise<ResolvedEndpoint | null> {
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
  // The AI Gateway endpoint ships with no stored key: the deployment's own
  // OIDC token (or an explicit AI_GATEWAY_API_KEY) authenticates the request.
  apiKey ??= await gatewayKeyFor(endpoint.baseUrl);

  return {
    label: endpoint.label,
    pricing: await pricingForModel(db, endpoint, model),
    // One resolver for every call site: a built-in's URL, wire format and
    // required headers come from the shared table, never from the row.
    config: endpointConfigForRow({
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      builtinId: endpoint.builtinId,
      model,
      session,
      ...(apiKey ? { apiKey } : {}),
    }),
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

  const session = row.conversation.id;
  const resolveEndpoint = options.resolveEndpoint
    ? (botRow: BotRow) => options.resolveEndpoint!(botRow, session)
    : (botRow: BotRow) => defaultResolveEndpoint(db, botRow, session);

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
    await finishMessage(db, { messageId: assistantMessageId, text: "", status: "error" });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text: "", status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: reason } });
    await setRunTerminal(db, { runId, status: "error", error: reason, finishedAt: now() });
    return { status: "error", assistantMessageId, text: "", error: reason };
  }

  const context = buildChatContext(row.bot, history);
  // The conversation the loop grows: system prompt and transcript, then each
  // assistant tool-call turn and its results.
  const conversation: ChatMessage[] = [...context];
  /*
   * The computer is offered as a tool, not woken up front: the machine is
   * obtained inside `run_command`, so a bot that only chats never provisions
   * one. That is the whole point of the lazy lifecycle, and it is why no step
   * label says "Waking your computer" before the model has asked for anything.
   */
  const runTools = [
    ...(options.tools ?? []),
    ...(options.computer ? [runCommandTool(options.computer, row.bot.id)] : []),
  ];

  // Added after the run's own tools so `run_command` is in the index code mode
  // builds from, rather than being the one tool a program cannot call.
  //
  // A run that already has a `codemode` is not wrapped again: the registry keys by
  // name, so two would collapse into one and the model would read a shell whose index
  // lists only itself. See `isCodeMode`.
  const code = isCodeMode(runTools) ? null : codemodeTool(runTools);
  const registry = createToolRegistry(code ? [...runTools, code] : runTools);

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
  // Text of the current model turn, which is what an assistant tool-call message
  // carries: earlier turns already went out as their own messages.
  let turnText = "";
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
  /** The last refusal a tool produced, if the model never spoke after it. */
  let lastObstacle: string | undefined;
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

  try {
    rotate = setInterval(() => {
      if (sawToken || controller.signal.aborted) return;
      void events
        .append({ type: "step", payload: { label: stepLabel(++stepIndex) } })
        .catch(() => {});
    }, STEP_ROTATE_MS);

    // The tool loop. One iteration is one model turn; a turn that asks for tools
    // runs them, appends the calls and their results, and streams again, so a model
    // can act and then talk about what it did. Nothing here is tool-specific: the
    // handlers come from `options.tools`, which is where the vault and the driver
    // each register themselves.
    for (let step = 0; ; step += 1) {
      if (controller.signal.aborted) break;
      if (step > MAX_TOOL_STEPS) {
        failure = `the bot used more than ${MAX_TOOL_STEPS} tool steps on one message`;
        break;
      }

      const toolSchemas = schemasOf(registry);
      const calls: CollectedCall[] = [];
      let turnFailed = false;

      const stream = gateway.stream({
        endpoint: resolved.config,
        messages: conversation,
        signal: controller.signal,
        ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
      });

      for await (const event of stream) {
        if (controller.signal.aborted) break;

        if (event.type === "text_delta") {
          sawToken = true;
          text += event.text;
          turnText += event.text;
          pendingText += event.text;
          await flush();
        } else if (event.type === "reasoning_delta") {
          reasoning += event.text;
          pendingReasoning += event.text;
          await flush();
        } else if (event.type === "tool_call_start") {
          sawToken = true;
          const existing = calls.find((call) => call.id === event.id);
          if (existing) existing.name = event.name || existing.name;
          else calls.push({ id: event.id, name: event.name, arguments: "" });
        } else if (event.type === "tool_call_delta") {
          const call = calls.find((entry) => entry.id === event.id);
          if (call) call.arguments += event.argumentsDelta;
        } else if (event.type === "tool_call_end") {
          const call = calls.find((entry) => entry.id === event.id);
          if (call) {
            call.arguments = event.arguments || call.arguments;
            if (!call.name) call.name = event.arguments ? call.name : call.name;
          } else {
            calls.push({ id: event.id, name: "", arguments: event.arguments });
          }
        } else if (event.type === "usage") {
          // Every turn of a tool loop is billed, so they add up rather than replace.
          inputTokens = (inputTokens ?? 0) + (event.inputTokens ?? 0) || inputTokens;
          outputTokens = (outputTokens ?? 0) + (event.outputTokens ?? 0) || outputTokens;
          if (event.cacheReadTokens !== undefined) {
            cacheReadTokens = (cacheReadTokens ?? 0) + event.cacheReadTokens;
          }
          if (event.cacheWriteTokens !== undefined) {
            cacheWriteTokens = (cacheWriteTokens ?? 0) + event.cacheWriteTokens;
          }
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
          turnFailed = true;
          break;
        }
      }

      if (turnFailed || controller.signal.aborted) break;

      const usable = calls.filter((call) => call.name);
      if (usable.length === 0) break;

      // Whatever the model said before calling a tool is narration, and the next
      // turn's answer continues the same bubble: separate them so a sentence does
      // not run straight into the next one.
      if (turnText.trim()) {
        const gap = text.trim() ? "\n\n" : "";
        text = `${text.trimEnd()}${gap}`;
        pendingText = `${pendingText}${gap}`;
        await flush(true);
      }

      // The assistant turn that asked for the tools is replayed with its calls, so
      // the next request is a valid conversation rather than a bare tool result.
      conversation.push({
        role: "assistant",
        content: turnText,
        toolCalls: usable.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      });
      turnText = "";

      let stopAfterTools = false;
      for (const call of usable) {
        const outcome = await runToolCall({
          db,
          events,
          registry,
          call,
          context: {
            workspaceId: row.bot.workspaceId,
            botId: row.bot.id,
            conversationId: row.conversation.id,
            runId,
            signal: controller.signal,
            emit: (event) => events.append(event),
          },
          runId,
          now,
        });
        if (outcome.result.startsWith("BLOCKED:")) lastObstacle = outcome.result;
        conversation.push({
          role: "tool",
          content: outcome.result,
          toolCallId: call.id,
          name: call.name,
        });
        if (outcome.endRun) {
          stopAfterTools = true;
          // A tool that ends the run has produced the answer; show it as the text.
          if (!text.trim() && outcome.result.trim()) {
            text = outcome.result;
            pendingText = outcome.result;
            await flush(true);
          }
        }
      }

      if (stopAfterTools) break;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failure = error instanceof Error ? error.message : "the model stream failed";
    }
  } finally {
    clearInterval(poll);
    if (rotate) clearInterval(rotate);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  /*
   * The model is what tells the user about a blocked tool. When it says nothing
   * at all, the run must still answer: an empty bubble reads as the bot ignoring
   * the request, and the refusal is the one thing the user needs to know.
   */
  if (!text.trim() && !failure && lastObstacle) {
    const lines = lastObstacle.split("\n");
    const summary = lines.find((line) => line.startsWith("BLOCKED: "));
    const resolution = lines.find((line) => line.startsWith("What the user can do: "));
    const retry = lines.find((line) => line.startsWith("Trying again"));
    text = [
      summary?.replace(/^BLOCKED: /, "I could not use my computer: "),
      resolution?.replace(/^What the user can do: /, "What you can do: "),
      retry,
    ]
      .filter(Boolean)
      .join(" ");
    pendingText = text;
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
    await finishMessage(db, { messageId: assistantMessageId, text, status: text ? "complete" : "error" });
    await events.append({ type: "message.completed", payload: { messageId: assistantMessageId, text, status: "error" } });
    await events.append({ type: "run.completed", payload: { status: "error", error: failure } });
    await setRunTerminal(db, {
      runId,
      status: "error",
      error: failure ?? "unknown error",
      finishedAt: now(),
      cost: costText,
    });
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
    cost: costText,
  });

  await db
    .update(conversationTable)
    .set({ lastMessagePreview: text.slice(0, 160), updatedAt: now() })
    .where(eq(conversationTable.id, row.conversation.id));

  void reasoning;
  return { status, assistantMessageId, text };
}

/**
 * Runs one tool call and records it.
 *
 * A handler that throws is a tool result the model can read and act on, not a dead
 * run: "that item is saved for github.com and this page is evil.test" is exactly
 * what lets a model recover, and an exception would take the whole message down
 * instead. The error text is the handler's own message, which every vault path
 * writes without a secret in it.
 */
async function runToolCall(input: {
  db: Database;
  events: EventLog;
  registry: ReturnType<typeof createToolRegistry>;
  call: CollectedCall;
  context: ToolContext;
  runId: string;
  now: () => Date;
}): Promise<{ result: string; endRun: boolean }> {
  const started = input.now();
  const parsed = parseToolArguments(input.call.arguments);
  const tool = input.registry.get(input.call.name);

  await input.events.append({
    type: "tool_call",
    payload: { id: input.call.id, name: input.call.name, status: "running" },
  });

  let result: string;
  let endRun = false;
  let status = "ok";

  if (!tool) {
    status = "unknown_tool";
    result = `there is no tool called "${input.call.name}"`;
  } else if (!parsed.ok) {
    status = "bad_arguments";
    result = `that tool call could not be read: ${parsed.error}`;
  } else {
    try {
      const outcome = await tool.handler(parsed.value, input.context);
      result = outcome.result;
      endRun = outcome.endRun ?? false;
    } catch (error) {
      status = "error";
      result = summariseToolError(error);
    }
  }

  const endedAt = input.now();
  await input.db.insert(toolCallTable).values({
    id: newId(),
    runId: input.runId,
    name: input.call.name,
    input: parsed.ok ? parsed.value : { raw: input.call.arguments.slice(0, 500) },
    output: { result, status },
    status,
    startedAt: started,
    endedAt,
  });

  await input.events.append({
    type: "tool_call",
    payload: { id: input.call.id, name: input.call.name, status, result },
  });

  return { result, endRun };
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
    cost?: string | null;
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
