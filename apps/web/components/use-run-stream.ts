"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageView } from "../lib/types.ts";

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface StreamingMessage {
  runId: string;
  messageId: string | null;
  text: string;
  step: string | null;
  /** A credential the bot is asking for, if one is pending in this run. */
  request: PendingSecretRequest | null;
}

/** The question a card renders. It never carries a value. */
export interface PendingSecretRequest {
  requestId: string;
  kind: "login" | "card" | "contact";
  reason: string;
  domain: string | null;
  expiresAt: string;
}

interface StreamOptions {
  conversationId: string;
  apiUrl: string;
  initialMessages: MessageView[];
  initialActiveRunId: string | null;
}

/**
 * Subscribes to a run's replay log. Two runs can be in flight for a moment
 * (the old one finishing after the interrupt), so each subscription keeps its
 * own state and only the newest owns the streaming bubble.
 */
export function useConversationStream({ conversationId, apiUrl, initialMessages, initialActiveRunId }: StreamOptions) {
  const [messages, setMessages] = useState<MessageView[]>(initialMessages);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sources = useRef(new Map<string, EventSource>());
  const currentRun = useRef<string | null>(null);

  const appendMessage = useCallback((message: MessageView) => {
    setMessages((existing) =>
      existing.some((entry) => entry.id === message.id) ? existing : [...existing, message],
    );
  }, []);

  const subscribe = useCallback(
    (runId: string) => {
      if (sources.current.has(runId)) return;
      currentRun.current = runId;
      setStreaming({ runId, messageId: null, text: "", step: null, request: null });

      const source = new EventSource(`${apiUrl}/runs/${runId}/events?after=0`, { withCredentials: true });
      sources.current.set(runId, source);

      const patch = (update: (state: StreamingMessage) => StreamingMessage) => {
        setStreaming((state) => (state && state.runId === runId ? update(state) : state));
      };

      source.addEventListener("run.started", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { payload: { messageId: string } };
        patch((state) => ({ ...state, messageId: data.payload.messageId }));
      });

      source.addEventListener("step", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { payload: { label: string } };
        patch((state) => ({ ...state, step: data.payload.label }));
      });

      source.addEventListener("text_delta", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { payload: { text: string } };
        patch((state) => ({ ...state, text: state.text + data.payload.text }));
      });

      // The bot asked for a credential. The event carries the question only, so the
      // card can render from it without any value existing anywhere yet.
      source.addEventListener("secret.request", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { payload: PendingSecretRequest };
        patch((state) => ({ ...state, request: data.payload }));
      });

      source.addEventListener("message.completed", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as {
          payload: { messageId: string; text: string; status: "complete" | "error" };
        };
        appendMessage({
          id: data.payload.messageId,
          role: "assistant",
          parts: [{ type: "text", text: data.payload.text }],
          status: data.payload.status === "error" ? "error" : "complete",
          createdAt: new Date().toISOString(),
          runId,
        });
      });

      source.addEventListener("run.completed", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as {
          payload: { status: string; error?: string };
        };
        if (data.payload.status === "error" && data.payload.error) setError(data.payload.error);
        source.close();
        sources.current.delete(runId);
        setStreaming((state) => (state && state.runId === runId ? null : state));
      });

      source.addEventListener("done", () => {
        source.close();
        sources.current.delete(runId);
        setStreaming((state) => (state && state.runId === runId ? null : state));
      });

      source.addEventListener("error", (event) => {
        const raw = event as MessageEvent;
        if (!raw.data) return;
        try {
          const data = JSON.parse(raw.data) as { message?: string };
          if (data.message) setError(data.message);
        } catch {
          setError("The stream stopped. Reconnecting…");
        }
      });

      source.onerror = () => {
        source.close();
        sources.current.delete(runId);
        setStreaming((state) => (state && state.runId === runId ? null : state));
      };
    },
    [apiUrl, appendMessage],
  );

  useEffect(() => {
    if (initialActiveRunId) subscribe(initialActiveRunId);
    const active = sources.current;
    return () => {
      for (const source of active.values()) source.close();
      active.clear();
    };
  }, [initialActiveRunId, subscribe]);

  const upload = useCallback(
    async (file: File): Promise<UploadedFile> => {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`${apiUrl}/attachments`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          detail?.error === "too_large" ? "That file is over the 4 MB limit." : "That file did not upload.",
        );
      }
      return (await response.json()) as UploadedFile;
    },
    [apiUrl],
  );

  const send = useCallback(
    async (text: string, quote?: { messageId: string; text: string }, files: UploadedFile[] = []): Promise<boolean> => {
      const trimmed = text.trim();
      if ((!trimmed && files.length === 0) || sending) return false;
      setSending(true);
      setError(null);

      try {
        const response = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: trimmed,
            ...(quote ? { quote } : {}),
            ...(files.length > 0 ? { attachments: files } : {}),
          }),
        });

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as {
            error?: string;
            gate?: { code: string; situation: string; resolution: string };
          } | null;
          // A gate refusal is an answer, not a failure: it arrives as the bot's
          // own reply so the thread explains the situation the same way the run
          // would, and the composer keeps the draft.
          if (response.status === 402 && detail?.gate) {
            appendMessage({
              id: `gate-${detail.gate.code}-${Date.now()}`,
              role: "assistant",
              parts: [{ type: "text", text: `${detail.gate.situation} ${detail.gate.resolution}` }],
              status: "complete",
              createdAt: new Date().toISOString(),
              runId: null,
            });
            return false;
          }
          setError(
            detail?.error === "unauthorized"
              ? "Your session expired. Sign in again."
              : detail?.error === "invalid_attachment"
                ? "A file in this message is no longer available. Remove it and send again."
                : "That message did not send.",
          );
          return false;
        }

        const data = (await response.json()) as { runId: string; messageId: string };
        appendMessage({
          id: data.messageId,
          role: "user",
          parts: [
            ...(quote ? [{ type: "quote" as const, messageId: quote.messageId, text: quote.text }] : []),
            ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
            ...files.map((file) => ({
              type: "file" as const,
              attachmentId: file.id,
              name: file.name,
              size: file.size,
              mime: file.mime,
            })),
          ],
          status: "complete",
          createdAt: new Date().toISOString(),
          runId: null,
        });
        subscribe(data.runId);
        return true;
      } catch {
        setError("You look offline. The message will send when you reconnect.");
        return false;
      } finally {
        setSending(false);
      }
    },
    [apiUrl, appendMessage, conversationId, sending, subscribe],
  );

  /** After a card resolves, its request is no longer pending. */
  const clearRequest = useCallback(() => {
    setStreaming((state) => (state ? { ...state, request: null } : state));
  }, []);

  return { messages, streaming, error, send, upload, sending, clearRequest, dismissError: () => setError(null) };
}
