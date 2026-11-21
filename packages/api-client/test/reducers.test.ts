import { describe, expect, it } from "vitest";
import {
  addUserMessage,
  applyRunEvent,
  blockReason,
  botStatusLine,
  canChat,
  emptyChat,
  finishStream,
  mergeHistory,
  messageQuote,
  messageText,
  startRun,
  withHistory,
} from "../src/reducers.ts";
import type { BotSummary, ChatMessage, RunEvent } from "../src/types.ts";

const RUN = "run-1";

function event(type: string, payload: Record<string, unknown> = {}, seq = 1): RunEvent {
  return { seq, type, payload, createdAt: "2026-11-21T10:00:00.000Z" };
}

function assistant(id: string, text: string, status = "complete"): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    status,
    createdAt: "2026-11-21T10:00:01.000Z",
    runId: RUN,
  };
}

function userMessage(id: string, text: string, quote?: string): ChatMessage {
  return {
    id,
    role: "user",
    parts: [...(quote ? [{ type: "quote" as const, messageId: "m0", text: quote }] : []), { type: "text", text }],
    status: "complete",
    createdAt: "2026-11-21T10:00:02.000Z",
    runId: null,
  };
}

describe("chat reducer", () => {
  it("accumulates streamed deltas into one turn", () => {
    let state = startRun(emptyChat, RUN);
    state = applyRunEvent(state, RUN, event("run.started", { messageId: "m1" }));
    state = applyRunEvent(state, RUN, event("text_delta", { text: "Hel" }));
    state = applyRunEvent(state, RUN, event("text_delta", { text: "lo" }));
    state = applyRunEvent(state, RUN, event("step", { label: "Thinking" }));

    expect(state.streaming).toMatchObject({ runId: RUN, messageId: "m1", text: "Hello", step: "Thinking" });
    expect(state.messages).toEqual([]);
  });

  it("appends the finished message once and clears the turn", () => {
    let state = startRun(emptyChat, RUN);
    state = applyRunEvent(state, RUN, event("text_delta", { text: "Hello" }));
    state = applyRunEvent(
      state,
      RUN,
      event("message.completed", { messageId: "m1", text: "Hello there", status: "complete" }),
    );

    expect(state.streaming?.completed).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(messageText(state.messages[0]!)).toBe("Hello there");

    state = applyRunEvent(state, RUN, event("message.completed", { messageId: "m1", text: "Hello there" }));
    expect(state.messages).toHaveLength(1);

    state = applyRunEvent(state, RUN, event("run.completed", { status: "done" }));
    expect(state.streaming).toBeNull();
    expect(state.error).toBeNull();
  });

  it("surfaces a failed run without dropping what was streamed", () => {
    let state = startRun(emptyChat, RUN);
    state = applyRunEvent(state, RUN, event("text_delta", { text: "partial" }));
    state = applyRunEvent(state, RUN, event("run.completed", { status: "error", error: "quota exceeded" }));

    expect(state.error).toBe("quota exceeded");
    expect(state.streaming).toBeNull();
  });

  it("ignores events from a run that is no longer on screen", () => {
    const state = startRun(emptyChat, "run-2");
    const next = applyRunEvent(state, RUN, event("text_delta", { text: "stale" }));
    expect(next).toBe(state);
  });

  it("closes the turn on the stream's done frame", () => {
    const state = startRun(emptyChat, RUN);
    expect(finishStream(state, RUN).streaming).toBeNull();
    expect(finishStream(state, "other")).toBe(state);
  });

  it("keeps a locally sent message when history arrives without it", () => {
    let state = withHistory([assistant("m1", "hi")]);
    state = addUserMessage(state, userMessage("m2", "how are you", "hi"));

    const next = mergeHistory(state, [assistant("m1", "hi")]);
    expect(next.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("takes the server's version of a message it already has", () => {
    const state = withHistory([assistant("m1", "part", "streaming")]);
    const next = mergeHistory(state, [assistant("m1", "complete answer")]);
    expect(next.messages).toHaveLength(1);
    expect(messageText(next.messages[0]!)).toBe("complete answer");
  });

  it("reads the quote and the text of a message", () => {
    const message = userMessage("m2", "and this", "earlier words");
    expect(messageText(message)).toBe("and this");
    expect(messageQuote(message)).toBe("earlier words");
    expect(messageQuote(assistant("m3", "no quote"))).toBeNull();
  });
});

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id: "bot-1",
    name: "Tera",
    avatar: { shape: "mug", color: "amber" },
    accentColor: "#f69412",
    unread: false,
    pinned: false,
    isPrimary: true,
    position: 0,
    conversationId: "conv-1",
    lastMessagePreview: null,
    lastMessageAt: null,
    computer: { id: "c1", provider: "instabox", status: "awake", lastUsedAt: null },
    model: {
      endpointId: "e1",
      endpointLabel: "OpenAI",
      kind: "openai-chat",
      modelId: "gpt-6-luna",
      contextWindow: 1050000,
      catalogMatch: "matched",
    },
    activeRun: false,
    ...overrides,
  };
}

describe("bot status line", () => {
  it("puts an in-flight reply above everything else", () => {
    expect(botStatusLine(bot({ activeRun: true }))).toEqual({ text: "Replying…", tone: "working" });
  });

  it("reads the computer state when idle", () => {
    expect(botStatusLine(bot())).toEqual({ text: "Awake · gpt-6-luna", tone: "awake" });
    expect(botStatusLine(bot({ model: null }))).toEqual({ text: "Awake", tone: "awake" });
    expect(
      botStatusLine(bot({ computer: { id: "c1", provider: "instabox", status: "asleep", lastUsedAt: null } })),
    ).toEqual({ text: "Sleeping", tone: "sleeping" });
    expect(
      botStatusLine(bot({ computer: { id: "c1", provider: "instabox", status: "provisioning", lastUsedAt: null } })),
    ).toEqual({ text: "Starting computer…", tone: "warning" });
    expect(botStatusLine(bot({ computer: null }))).toEqual({ text: "No computer yet", tone: "warning" });
    expect(
      botStatusLine(bot({ computer: { id: "c1", provider: "instabox", status: "error", lastUsedAt: null } })),
    ).toEqual({ text: "Computer error", tone: "warning" });
  });

  it("blocks chat only when there is no usable computer", () => {
    expect(canChat(bot())).toBe(true);
    expect(canChat(bot({ computer: null }))).toBe(false);
    expect(blockReason(bot())).toBeNull();
    expect(blockReason(bot({ computer: null }))).toContain("no computer");
    expect(
      blockReason(bot({ computer: { id: "c1", provider: "instabox", status: "error", lastUsedAt: null } })),
    ).toContain("error");
  });
});
