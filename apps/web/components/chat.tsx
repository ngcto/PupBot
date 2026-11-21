"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Share01Icon } from "@hugeicons/core-free-icons";
import { Avatar } from "@terabot/avatars/react";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
  Tooltip,
  cn,
  toast,
} from "@terabot/ui";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatTimestamp } from "../lib/format.ts";
import type { BotView, MessageView, PendingRequestView } from "../lib/types.ts";
import { Composer } from "./composer.tsx";
import { MessageBubble } from "./message-bubble.tsx";
import { Markdown } from "./markdown.tsx";
import { SecretRequestCard } from "./secret-request-card.tsx";
import { useConversationStream } from "./use-run-stream.ts";

const GROUP_GAP_MS = 10 * 60 * 1000;

export function Chat({
  bot,
  apiUrl,
  initialMessages,
  activeRunId,
  pendingRequest,
  onGiveComputer,
  onManageProviders,
}: {
  bot: BotView;
  apiUrl: string;
  initialMessages: MessageView[];
  activeRunId: string | null;
  /** A card the bot is still waiting on, read on load so a reload never loses it. */
  pendingRequest: PendingRequestView | null;
  onGiveComputer: () => void;
  onManageProviders: () => void;
}) {
  const router = useRouter();
  const { messages, streaming, error, send, upload, sending, clearRequest, dismissError } = useConversationStream({
    conversationId: bot.conversationId,
    apiUrl,
    initialMessages,
    initialActiveRunId: activeRunId,
  });
  const [reply, setReply] = useState<{ messageId: string; text: string } | null>(null);
  // A card read from the database on load, cleared once it is answered.
  const [restoredRequest, setRestoredRequest] = useState(pendingRequest);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const rows = useMemo(() => buildRows(messages), [messages]);

  // One card at a time: a live request from the event stream wins over one read from
  // the database on load, because the live one is the newest.
  const liveRequest = useMemo(
    () =>
      streaming?.request
        ? {
            requestId: streaming.request.requestId,
            kind: streaming.request.kind,
            reason: streaming.request.reason,
            domain: streaming.request.domain,
            expiresAt: streaming.request.expiresAt,
          }
        : restoredRequest,
    [streaming?.request, restoredRequest],
  );

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    // Land at the latest message when the bot opens.
  }, []);

  useEffect(() => {
    if (!atBottom.current) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length, streaming?.text]);

  useEffect(() => {
    if (!streaming && messages.length > 0) router.refresh();
    // The sidebar preview and unread state come from the server; refresh once a run lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming?.runId]);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
      <ChipRow bot={bot} />

      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-[960px] max-w-full px-4 pb-6 pt-[70px]">
          {messages.length === 0 && !streaming ? (
            <div className="flex flex-col items-center gap-1 pt-24 text-center">
              <p className="text-body text-ink">{bot.name} hasn&apos;t said anything yet.</p>
              <p className="text-body text-ink-muted">Send a message to get started.</p>
            </div>
          ) : null}

          <div className="flex flex-col">
            {rows.map((row) =>
              row.kind === "separator" ? (
                <p key={row.key} className="my-5 text-center text-sm text-ink-tertiary">
                  {row.label}
                </p>
              ) : (
                <div
                  key={row.message.id}
                  className={cn(
                    "flex flex-col",
                    row.message.role === "user" ? "items-end" : "items-start",
                    row.spacing === "same" ? "mt-[5px]" : "mt-6",
                  )}
                >
                  <MessageBubble
                    message={row.message}
                    accentColor={bot.accentColor}
                    onReply={(quote) => setReply(quote)}
                  />
                </div>
              ),
            )}
            {liveRequest ? (
              <div className="mt-6 flex flex-col items-start" data-testid="secret-request-wrap">
                <SecretRequestCard
                  apiUrl={apiUrl}
                  requestId={liveRequest.requestId}
                  seed={liveRequest}
                  onResolved={() => {
                    clearRequest();
                    setRestoredRequest(null);
                    router.refresh();
                  }}
                />
              </div>
            ) : null}
            {streaming ? <StreamingTurn bot={bot} streaming={streaming} /> : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="mx-auto mb-2 w-[960px] max-w-full px-4">
          <div className="flex items-center gap-2 rounded-md border border-card bg-raised px-3 py-2 text-base text-ink-secondary">
            <span className="flex-1">That run stopped: {error}.</span>
            <button type="button" className="text-ink-muted hover:text-ink" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <Composer
        bot={bot}
        onSend={(text, quote, files) => send(text, quote, files)}
        onAttach={upload}
        reply={reply}
        onCancelReply={() => setReply(null)}
        onGiveComputer={onGiveComputer}
        onManageProviders={onManageProviders}
        pending={sending}
      />
    </div>
  );
}

function ChipRow({ bot }: { bot: BotView }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[62px] items-start justify-center bg-gradient-to-b from-canvas via-canvas/90 to-transparent pt-[7px]">
        <div
          data-testid="bot-chip"
          className="pointer-events-auto flex h-[39px] items-center gap-2 rounded-pill border border-white/[0.06] bg-raised pl-2 pr-3.5"
        >
          <Avatar shape={bot.shape as never} color={bot.color} size={20} title="" />
          <span className="text-body font-semibold">{bot.name}</span>
        </div>
      </div>
      <div className="absolute right-4 top-[9px] z-20">
        <MenuRoot>
          <MenuTrigger>
            <button
              type="button"
              className="flex h-9 w-[72px] items-center justify-center gap-1.5 rounded-pill bg-raised-1 text-base font-medium text-ink hover:bg-raised-2"
            >
              <HugeiconsIcon icon={Share01Icon} size={14} strokeWidth={1.8} />
              Share
            </button>
          </MenuTrigger>
          <MenuPopup align="end" className="w-[232px]">
            <MenuItem
              className="h-auto flex-col items-start gap-0.5 py-2"
              onClick={() => toast("Template links land in P3.")}
            >
              <span>Create a copy</span>
              <span className="text-sm text-ink-muted">Share a template link</span>
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </div>
    </>
  );
}

function StreamingTurn({
  bot,
  streaming,
}: {
  bot: BotView;
  streaming: { text: string; step: string | null };
}) {
  const reduced = useReducedMotion();

  if (streaming.text) {
    return (
      <div className="mt-6 flex max-w-[560px] flex-col">
        <div data-testid="streaming-text" className="text-body text-ink">
          <Markdown text={streaming.text} />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="run-step" className="mt-6 flex h-7 items-center gap-2.5">
      {streaming.step ? (
        <Avatar shape={bot.shape as never} color={bot.color} size={28} title="" />
      ) : (
        <span className="flex items-center gap-[5px] pl-1">
          {[0, 1, 2].map((index) => (
            <motion.span
              key={index}
              className="block size-1.5 rounded-pill"
              style={{ background: bot.accentColor }}
              animate={reduced ? { opacity: 0.6 } : { opacity: [0.3, 1, 0.3], scale: [1, 1.06, 1] }}
              transition={{ duration: 0.9, repeat: Infinity, delay: index * 0.12, ease: "easeInOut" }}
            />
          ))}
        </span>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={streaming.step ?? "typing"}
          className="text-body text-ink-muted"
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.12 }}
        >
          {streaming.step ?? "Typing…"}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

type Row =
  | { kind: "separator"; key: string; label: string }
  | { kind: "message"; message: MessageView; spacing: "same" | "group" };

function buildRows(messages: MessageView[]): Row[] {
  const rows: Row[] = [];
  let previous: MessageView | null = null;

  for (const message of messages) {
    if (message.status === "streaming") continue;
    const previousTime = previous ? new Date(previous.createdAt).getTime() : 0;
    const time = new Date(message.createdAt).getTime();
    if (!previous || time - previousTime > GROUP_GAP_MS) {
      rows.push({ kind: "separator", key: `sep-${message.id}`, label: formatTimestamp(message.createdAt) });
      rows.push({ kind: "message", message, spacing: "group" });
    } else {
      rows.push({
        kind: "message",
        message,
        spacing: previous.role === message.role ? "same" : "group",
      });
    }
    previous = message;
  }
  return rows;
}

export function JumpToBottom({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Jump to the latest">
      <button
        type="button"
        onClick={onClick}
        className="flex size-8 items-center justify-center rounded-pill bg-raised text-ink-secondary hover:bg-raised-2"
      >
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} />
      </button>
    </Tooltip>
  );
}
