"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowTurnBackwardIcon,
  Copy01Icon,
  File02Icon,
  MoreHorizontalCircle01Icon,
} from "@hugeicons/core-free-icons";
import { deriveAccent } from "@terabot/avatars";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
  Tooltip,
  cn,
  toast,
} from "@terabot/ui";
import type { MessagePart } from "@terabot/db";
import { formatFileSize } from "../lib/format.ts";
import type { MessageView } from "../lib/types.ts";
import { Markdown } from "./markdown.tsx";

function textOf(parts: MessagePart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

function QuoteChip({ text }: { text: string }) {
  return (
    <div className="mb-1.5 line-clamp-3 rounded-sm bg-raised px-2.5 py-1.5 text-sm text-ink-muted">{text}</div>
  );
}

export function FileCard({ name, size, mime }: { name: string; size: number; mime: string }) {
  const colour = mime.includes("pdf")
    ? "#e8384f"
    : mime.startsWith("image/")
      ? "#905afb"
      : mime.includes("sheet") || mime.includes("csv")
        ? "#1fbf72"
        : "#1884fc";
  return (
    <div className="w-[240px] overflow-hidden rounded-md border border-card bg-raised">
      <div className="flex items-start gap-2 p-2.5">
        <HugeiconsIcon icon={File02Icon} size={18} strokeWidth={1.7} className="mt-0.5 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base text-ink">{name}</p>
          <p className="mt-0.5 text-sm text-ink-muted">{formatFileSize(size)}</p>
        </div>
      </div>
      <div className="h-[3px] w-full" style={{ background: colour }} />
    </div>
  );
}

export function MessageBubble({
  message,
  accentColor,
  onReply,
}: {
  message: MessageView;
  accentColor: string;
  onReply?: (quote: { messageId: string; text: string }) => void;
}) {
  const isUser = message.role === "user";
  const text = textOf(message.parts);
  const quote = message.parts.find((part) => part.type === "quote");
  const files = message.parts.filter((part) => part.type === "file" || part.type === "image");

  const copy = (value: string, label: string) => {
    void navigator.clipboard.writeText(value);
    toast(label);
  };

  return (
    <div className={cn("group/message flex w-full flex-col", isUser ? "items-end" : "items-start")}>
      <div className={cn("relative flex max-w-[560px] flex-col", isUser ? "items-end" : "items-start")}>
        {files.length > 0 ? (
          <div className={cn("mb-1.5 flex flex-wrap gap-2", isUser ? "justify-end" : "justify-start")}>
            {files.map((file, index) =>
              file.type === "file" ? (
                <FileCard key={`${file.name}-${index}`} name={file.name} size={file.size} mime={file.mime} />
              ) : null,
            )}
          </div>
        ) : null}

        {text || quote ? (
          <div
            className={cn(
              "rounded-lg px-3 py-[7px] text-body text-ink",
              isUser ? "border border-transparent" : "bubble-fill",
            )}
            style={isUser ? { background: deriveAccent(accentColor) } : undefined}
          >
            {quote && quote.type === "quote" ? <QuoteChip text={quote.text} /> : null}
            {text ? <Markdown text={text} /> : null}
          </div>
        ) : null}

        {message.status === "error" ? (
          <p className="mt-1 text-sm text-danger">That run stopped before it finished.</p>
        ) : null}

        <div
          className={cn(
            "pointer-events-none absolute -top-8 flex items-center gap-0.5 rounded-pill border border-menu bg-raised px-1 py-0.5 opacity-0 shadow-menu transition-opacity duration-100",
            "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
            "right-0",
          )}
        >
          <Tooltip content="Copy">
            <button
              type="button"
              aria-label="Copy message"
              className="flex size-6 items-center justify-center rounded-pill text-ink-secondary hover:bg-raised-3 hover:text-ink"
              onClick={() => copy(text, "Copied")}
            >
              <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.8} />
            </button>
          </Tooltip>
          {onReply && text ? (
            <Tooltip content="Reply">
              <button
                type="button"
                aria-label="Reply to message"
                className="flex size-6 items-center justify-center rounded-pill text-ink-secondary hover:bg-raised-3 hover:text-ink"
                onClick={() => onReply({ messageId: message.id, text })}
              >
                <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={14} strokeWidth={1.8} />
              </button>
            </Tooltip>
          ) : null}
          <MenuRoot>
            <MenuTrigger>
              <button
                type="button"
                aria-label="More"
                className="flex size-6 items-center justify-center rounded-pill text-ink-secondary hover:bg-raised-3 hover:text-ink"
              >
                <HugeiconsIcon icon={MoreHorizontalCircle01Icon} size={14} strokeWidth={1.8} />
              </button>
            </MenuTrigger>
            <MenuPopup align={isUser ? "end" : "start"}>
              <MenuItem onClick={() => copy(text, "Copied")}>Copy</MenuItem>
              <MenuItem onClick={() => copy(message.runId ?? message.id, "Request ID copied")}>
                Copy request ID
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        </div>
      </div>
    </div>
  );
}
