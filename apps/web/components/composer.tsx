"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Mic01Icon,
  PlusSignIcon,
  ArrowUp02Icon,
  VoiceIcon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@pupbot/avatars/react";
import { Button, MenuItem, MenuPopup, MenuRoot, MenuTrigger, Tooltip, cn, toast } from "@pupbot/ui";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { UploadedFile } from "./use-run-stream.ts";
import type { BotView } from "../lib/types.ts";

interface ComposerProps {
  bot: BotView;
  /** Resolves true once the message is accepted, so a failed send keeps the draft. */
  onSend: (text: string, quote?: { messageId: string; text: string }, files?: UploadedFile[]) => Promise<boolean>;
  onAttach: (file: File) => Promise<UploadedFile>;
  reply: { messageId: string; text: string } | null;
  onCancelReply: () => void;
  onGiveComputer: () => void;
  pending?: boolean;
}

const DRAFT_PREFIX = "pupbot:draft:";

/** The message API refuses more than this, so the picker stops here. */
const MAX_ATTACHMENTS = 8;

export function Composer({
  bot,
  onSend,
  onAttach,
  reply,
  onCancelReply,
  onGiveComputer,
  pending,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const attach = async (picked: FileList | null) => {
    const chosen = Array.from(picked ?? []);
    if (chosen.length === 0) return;
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      toast(`A message can carry ${MAX_ATTACHMENTS} files.`);
      if (picker.current) picker.current.value = "";
      return;
    }
    if (chosen.length > room) toast(`Only ${room} more file${room === 1 ? "" : "s"} fit in this message.`);
    setUploading(true);
    try {
      for (const file of chosen.slice(0, room)) {
        try {
          const uploaded = await onAttach(file);
          setFiles((existing) => [...existing, uploaded]);
        } catch (error) {
          toast(error instanceof Error ? error.message : "That file did not upload.");
        }
      }
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  };

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

  if (bot.computer.binding !== "ready") {
    return (
      <div className="mx-auto w-[960px] max-w-full px-4 pb-[18px]">
        <ComputerGate bot={bot} onConnect={onGiveComputer} />
      </div>
    );
  }

  const canSend = value.trim().length > 0 || files.length > 0;

  const submit = async () => {
    // A send in flight keeps the draft rather than clearing text it drops.
    if (!canSend || uploading || pending) return;
    const sent = value;
    const sentFiles = files;
    const accepted = await onSend(sent, reply ?? undefined, sentFiles);
    if (!accepted) return;
    // The composer stays editable while the POST is in flight, so a draft typed
    // during it, and files attached or removed during it, belong to the next
    // message. Only what actually went out is dropped.
    setValue((current) => (current === sent ? "" : current));
    setFiles((current) => current.filter((file) => !sentFiles.some((sent) => sent.id === file.id)));
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

        {files.length > 0 || uploading ? (
          <div className="flex flex-wrap gap-1.5 border-b border-menu px-3 py-2" data-testid="attachment-chips">
            {files.map((file) => (
              <span
                key={file.id}
                className="flex items-center gap-1.5 rounded-pill bg-raised-2 py-1 pl-2.5 pr-1.5 text-sm text-ink-secondary"
              >
                <span className="max-w-[220px] truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  className="text-ink-faint hover:text-ink"
                  onClick={() => setFiles((existing) => existing.filter((entry) => entry.id !== file.id))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </button>
              </span>
            ))}
            {uploading ? <span className="text-sm text-ink-faint">Uploading…</span> : null}
          </div>
        ) : null}

        <div className="flex items-end gap-2.5 px-2 py-2">
          <RowTools bot={bot} onAttach={() => picker.current?.click()} />
          <input
            ref={picker}
            type="file"
            multiple
            data-testid="file-input"
            className="hidden"
            onChange={(event) => void attach(event.target.files)}
          />
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
                data-testid="send"
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
                  icon={ArrowUp02Icon}
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

/**
 * The three states that are not a composer: no computer, a computer being
 * allocated, and a blocked bot. Each says what is true and offers one action,
 * so nothing spins without a reason on screen.
 */
function ComputerGate({ bot, onConnect }: { bot: BotView; onConnect: () => void }) {
  const reduced = useReducedMotion();
  const { binding, reason } = bot.computer;

  if (binding === "binding") {
    return (
      <div
        data-testid="composer-allocating"
        className="flex items-center gap-3 rounded-lg border border-card bg-raised px-4 py-3.5"
      >
        <span className="relative flex size-8 items-center justify-center">
          <motion.span
            className="absolute inset-0 rounded-pill"
            style={{ background: bot.accentColor }}
            animate={reduced ? { opacity: 0.2 } : { opacity: [0.12, 0.3, 0.12], scale: [1, 1.08, 1] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
          <Avatar shape={bot.shape as never} color={bot.color} size={26} title="" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body text-ink">Connecting a computer…</p>
          <p className="text-body text-ink-secondary">This takes a few seconds.</p>
        </div>
      </div>
    );
  }

  const unbound = binding === "unbound";

  return (
    <div
      data-testid="composer-blocked"
      className="rounded-lg border border-card bg-raised px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        <Avatar shape={bot.shape as never} color={bot.color} size={32} title="" />
        <div className="min-w-0 flex-1">
          <p className="text-body text-ink">
            {unbound ? "This bot doesn't have a computer yet." : "This bot's computer isn't available."}
          </p>
          <p className="text-body text-ink-secondary">
            {unbound ? "Connect one and it can start working." : (reason ?? "Something went wrong on the computer side.")}
          </p>
        </div>
        <Button size="sm" variant="primary" className="h-8 px-3" onClick={onConnect}>
          {unbound ? "Connect a computer" : "Try again"}
        </Button>
      </div>
    </div>
  );
}

function RowTools({ bot, onAttach }: { bot: BotView; onAttach: () => void }) {
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
          <MenuItem onClick={onAttach}>Attach files</MenuItem>
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
