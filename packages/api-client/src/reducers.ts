import type { BotSummary, ChatMessage, RunEvent } from "./types.ts";

/**
 * The chat state machine, kept pure so it can be tested without a device.
 *
 * It mirrors `apps/web/components/use-run-stream.ts`: deltas accumulate into one
 * streaming turn, `message.completed` appends the finished message, and
 * `run.completed` (or the stream's `done` frame) closes the turn. An interrupted
 * run keeps the partial text visible until the next run's first delta, exactly
 * like the web client, because the worker persists that partial text as a message.
 */

export interface StreamingTurn {
  runId: string;
  messageId: string | null;
  text: string;
  step: string | null;
  completed: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  streaming: StreamingTurn | null;
  error: string | null;
}

export const emptyChat: ChatState = { messages: [], streaming: null, error: null };

export function withHistory(messages: ChatMessage[]): ChatState {
  return { messages: dedupe(messages), streaming: null, error: null };
}

function dedupe(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  return out;
}

const sameMessage = (a: ChatMessage, b: ChatMessage) =>
  a.id === b.id && a.status === b.status && messageText(a) === messageText(b);

/**
 * Server history wins on status and text, but local messages the server has not
 * returned yet stay where they are. Called after every finished run.
 */
export function mergeHistory(state: ChatState, messages: ChatMessage[]): ChatState {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  const merged: ChatMessage[] = [];
  for (const message of state.messages) merged.push(byId.get(message.id) ?? message);
  for (const message of messages) {
    if (!state.messages.some((local) => sameMessage(local, message))) {
      if (!merged.some((entry) => entry.id === message.id)) merged.push(message);
    }
  }
  merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { ...state, messages: merged };
}

export function addMessage(state: ChatState, message: ChatMessage): ChatState {
  if (state.messages.some((entry) => entry.id === message.id)) return state;
  return { ...state, messages: [...state.messages, message] };
}

export function addUserMessage(state: ChatState, message: ChatMessage): ChatState {
  return { ...addMessage(state, message), error: null };
}

export function startRun(state: ChatState, runId: string): ChatState {
  return {
    ...state,
    error: null,
    streaming: { runId, messageId: null, text: "", step: null, completed: false },
  };
}

export function setError(state: ChatState, error: string | null): ChatState {
  return { ...state, error };
}

/** A `done` frame means the replay log is over; the turn cannot stay open. */
export function finishStream(state: ChatState, runId: string): ChatState {
  if (state.streaming?.runId !== runId) return state;
  return { ...state, streaming: null };
}

export function applyRunEvent(state: ChatState, runId: string, event: RunEvent): ChatState {
  const streaming = state.streaming;
  const current = streaming?.runId === runId ? streaming : null;

  switch (event.type) {
    case "run.started": {
      if (!current) return state;
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
      return { ...state, streaming: { ...current, messageId } };
    }
    case "step": {
      if (!current) return state;
      const label = typeof event.payload.label === "string" ? event.payload.label : null;
      return { ...state, streaming: { ...current, step: label } };
    }
    case "text_delta": {
      if (!current) return state;
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (!text) return state;
      return { ...state, streaming: { ...current, text: current.text + text } };
    }
    case "message.completed": {
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
      if (!messageId) return state;
      const finalText = typeof event.payload.text === "string" ? event.payload.text : "";
      const status = event.payload.status === "error" ? "error" : "complete";
      const message: ChatMessage = {
        id: messageId,
        role: "assistant",
        parts: [{ type: "text", text: finalText }],
        status,
        createdAt: event.createdAt ?? new Date().toISOString(),
        runId,
      };
      const next = addMessage(state, message);
      if (!current) return next;
      return { ...next, streaming: { ...current, text: finalText, completed: true } };
    }
    case "run.completed": {
      const detail = typeof event.payload.error === "string" ? event.payload.error : null;
      const status = typeof event.payload.status === "string" ? event.payload.status : "done";
      const error = detail ?? (status === "error" ? "That run stopped." : null);
      const next = current ? { ...state, streaming: null } : state;
      return error ? { ...next, error } : next;
    }
    default:
      return state;
  }
}

export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function messageQuote(message: ChatMessage): string | null {
  const quote = message.parts.find((part) => part.type === "quote");
  return quote && quote.type === "quote" ? quote.text : null;
}

export type StatusTone = "working" | "awake" | "sleeping" | "warning" | "idle";

export interface StatusLine {
  text: string;
  tone: StatusTone;
}

/**
 * One line, at a glance: a phone row cannot hold a computer card, so the
 * computer's state and the model collapse into this. Order matters — a run in
 * flight is the most useful thing to know, then whether the bot can answer at all.
 */
export function botStatusLine(bot: BotSummary): StatusLine {
  if (bot.activeRun) return { text: "Replying…", tone: "working" };
  if (!bot.computer) return { text: "No computer yet", tone: "warning" };

  switch (bot.computer.status) {
    case "provisioning":
      return { text: "Starting computer…", tone: "warning" };
    case "awake":
      return bot.model
        ? { text: `Awake · ${bot.model.modelId}`, tone: "awake" }
        : { text: "Awake", tone: "awake" };
    case "asleep":
      return { text: "Sleeping", tone: "sleeping" };
    case "error":
      return { text: "Computer error", tone: "warning" };
    case "deleted":
      return { text: "No computer yet", tone: "warning" };
    default:
      return { text: "Unknown", tone: "idle" };
  }
}

/** A bot without a computer still opens; the composer explains why it is blocked. */
export function canChat(bot: BotSummary): boolean {
  return bot.computer !== null && bot.computer.status !== "deleted" && bot.computer.status !== "error";
}

export function blockReason(bot: BotSummary): string | null {
  if (!bot.computer) return "This bot has no computer yet. Give it one from the web app to chat.";
  if (bot.computer.status === "error") return "This bot's computer hit an error. Fix it from the web app.";
  if (bot.computer.status === "deleted") return "This bot's computer was deleted. Give it a new one to chat.";
  return null;
}
