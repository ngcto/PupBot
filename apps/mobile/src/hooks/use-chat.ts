import {
  addUserMessage,
  applyRunEvent,
  emptyChat,
  finishStream,
  mergeHistory,
  setError,
  startRun,
  withHistory,
} from "@terabot/api-client";
import type { BotDetail, ChatMessage, ChatState } from "@terabot/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

/**
 * One bot's conversation: history, a streamed reply, and an interrupt when a new
 * message is sent mid-answer. The state machine is `@terabot/api-client`'s reducer;
 * this hook only owns side effects (fetch, abort, refetch).
 */
export function useChat(botId: string) {
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [state, setState] = useState<ChatState>(emptyChat);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const streams = useRef(new Map<string, AbortController>());

  const refreshHistory = useCallback(async () => {
    const history = await api.messages(botId);
    setState((current) => mergeHistory(current, history.messages));
  }, [botId]);

  const consume = useCallback(
    async (runId: string) => {
      const controller = new AbortController();
      streams.current.set(runId, controller);

      try {
        await api.streamRun(runId, {
          after: 0,
          signal: controller.signal,
          onEvent: (event) => setState((current) => applyRunEvent(current, runId, event)),
        });
      } catch (caught) {
        if (!isAbort(caught)) setState((current) => setError(current, errorMessage(caught)));
      } finally {
        streams.current.delete(runId);
        setState((current) => finishStream(current, runId));
        // The worker persists the final (or partial, interrupted) text server-side.
        await refreshHistory().catch(() => {});
      }
    },
    [refreshHistory],
  );

  const load = useCallback(async () => {
    const [detail, history] = await Promise.all([api.getBot(botId), api.messages(botId)]);
    setBot(detail);
    setState(withHistory(history.messages));
    setLoading(false);

    const activeRunId = history.activeRun?.id;
    if (activeRunId) {
      setState((current) => startRun(current, activeRunId));
      void consume(activeRunId);
    }
  }, [botId, consume]);

  useEffect(() => {
    void load().catch((caught: unknown) => {
      setLoading(false);
      setState((current) => setError(current, errorMessage(caught)));
    });
  }, [load]);

  useEffect(() => {
    const open = streams.current;
    return () => {
      for (const controller of open.values()) controller.abort();
      open.clear();
    };
  }, []);

  const refreshBot = useCallback(async () => {
    try {
      setBot(await api.getBot(botId));
    } catch {
      // A background refresh that fails leaves the screen as it is.
    }
  }, [botId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !bot || sending) return;

      // A new message interrupts the reply in flight; the server keeps its partial text.
      for (const controller of streams.current.values()) controller.abort();
      setSending(true);

      try {
        const sent = await api.sendMessage(bot.conversationId, trimmed);
        const mine: ChatMessage = {
          id: sent.messageId,
          role: "user",
          parts: [{ type: "text", text: trimmed }],
          status: "complete",
          createdAt: new Date().toISOString(),
          runId: null,
        };
        setState((current) => startRun(addUserMessage(current, mine), sent.runId));
        void consume(sent.runId);
      } catch (caught) {
        setState((current) => setError(current, errorMessage(caught)));
      } finally {
        setSending(false);
      }
    },
    [bot, consume, sending],
  );

  return {
    bot,
    state,
    loading,
    sending,
    send,
    refreshBot,
    dismissError: () => setState((current) => setError(current, null)),
  };
}
