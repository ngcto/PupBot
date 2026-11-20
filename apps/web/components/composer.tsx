"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Mic01Icon,
  PlusSignIcon,
  SentIcon,
  VoiceIcon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@pupbot/avatars/react";
import { Button, MenuItem, MenuPopup, MenuRoot, MenuTrigger, Tooltip, cn, toast } from "@pupbot/ui";
import { useEffect, useRef, useState } from "react";
import type { BotView } from "../lib/types.ts";

interface ComposerProps {
  bot: BotView;
  onSend: (text: string, quote?: { messageId: string; text: string }) => void;
  reply: { messageId: string; text: string } | null;
  onCancelReply: () => void;
  onGiveComputer: () => void;
  pending?: boolean;
}

const DRAFT_PREFIX = "pupbot:draft:";

export function Composer({ bot, onSend, reply, onCancelReply, onGiveComputer, pending }: ComposerProps) {
  const [value, setValue] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(window.localStorage.getItem(`${DRAFT_PREFIX}${bot.id}`) ?? "");
  }, [bot.id]);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.localStorage.setItem(`${DRAFT_PREFIX}${bot.id}`, value);
    }, 250);
    return () => clearTimeout(timer);
  }, [bot.id, value]);

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  if (!bot.computer) {
    return (
      <div className="mx-auto w-[960px] max-w-full px-4 pb-[18px]">
        <div
          data-testid="composer-blocked"
          className="rounded-lg border border-card bg-raised px-4 py-3.5"
        >
          <div className="flex items-center gap-3">
            <Avatar shape={bot.shape as never} color={bot.color} size={32} title="" />
            <div className="min-w-0 flex-1">
              <p className="text-body text-ink">This bot doesn&apos;t have a computer yet.</p>
              <p className="text-body text-ink-secondary">Give it one and it can start working.</p>
            </div>
            <Button size="sm" variant="primary" className="h-8 px-3" onClick={onGiveComputer}>
              Give it a computer
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const canSend = value.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(value, reply ?? undefined);
    setValue("");
    onCancelReply();
    area.current?.focus();
  };

  return (
    <div className="mx-auto w-[960px] max-w-full px-4 pb-[18px]">
      <div
        className={cn(
          "flex flex-col rounded-[23px] rounded-lg border border-strong bg-raised",
          reply ? "rounded-lg" : "rounded-pill",
        )}
        style={reply ? undefined : { borderRadius: 23 }}
      >
        {reply ? (
          <div className="flex items-start gap-2 border-b border-menu px-4 py-2">
            <p className="line-clamp-1 flex-1 text-base text-ink-secondary">{reply.text}</p>
            <button
              type="button"
              aria-label="Cancel reply"
              className="text-ink-muted hover:text-ink"
              onClick={onCancelReply}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2.5 px-2 py-2">
          <RowTools bot={bot} />
          <textarea
            ref={area}
            rows={1}
            value={value}
            aria-label={`Message ${bot.name}`}
            placeholder={`Message ${bot.name}`}
            className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-body text-ink outline-none placeholder:text-ink-faint"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-2.5">
            <DiscButton label="Start voice chat" icon={Mic01Icon} onClick={() => toast("Voice chat lands in P2.")} />
            <DiscButton label="Voice chat" icon={VoiceIcon} onClick={() => toast("Voice chat lands in P2.")} />
            <Tooltip content={canSend ? "Send" : "Send"}>
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend || pending}
                onClick={submit}
                className={cn(
                  "flex size-7 items-center justify-center rounded-pill transition-[background,transform] duration-90 active:scale-[0.97]",
                  canSend ? "text-ink" : "bg-raised-3 text-ink-faint",
                )}
                style={canSend ? { background: sendAccent(bot.accentColor) } : undefined}
              >
                <HugeiconsIcon
                  icon={SentIcon}
                  size={14}
                  strokeWidth={2}
                  className={canSend && isNearWhite(bot.accentColor) ? "text-canvas" : undefined}
                />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function RowTools({ bot }: { bot: BotView }) {
  return (
    <div className="flex items-center gap-1.5">
      <MenuRoot>
        <MenuTrigger>
          <button
            type="button"
            aria-label="Attach"
            className="flex size-7 items-center justify-center rounded-pill bg-raised-2 text-ink-secondary transition-colors hover:bg-raised-3 hover:text-ink"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          </button>
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          <MenuItem onClick={() => toast("File uploads arrive with storage in P2.")}>
            Attach files
            <span className="ml-auto text-sm text-ink-faint">P2</span>
          </MenuItem>
          <MenuItem onClick={() => toast("Teach a task arrives with screen recording in P2.")}>
            Teach a task
            <span className="ml-auto text-sm text-ink-faint">P2</span>
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}

function DiscButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof Mic01Icon;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-7 items-center justify-center rounded-pill bg-raised-2 text-ink-secondary transition-colors hover:bg-raised-3 hover:text-ink"
      >
        <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} />
      </button>
    </Tooltip>
  );
}

function isNearWhite(hex: string): boolean {
  const value = hex.replace("#", "");
  const int = Number.parseInt(value, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return Math.min(r, g, b) > 200;
}

function sendAccent(hex: string): string {
  return isNearWhite(hex) ? "#f5f5f5" : hex;
}
