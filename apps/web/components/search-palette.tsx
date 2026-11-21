"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  CheckmarkSquare02Icon,
  LinkSquare01Icon,
  Search01Icon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@terabot/avatars/react";
import type { BotView } from "../lib/types.ts";
import { Command } from "cmdk";
import { useEffect } from "react";

export function SearchPalette({
  open,
  onOpenChange,
  bots,
  onSelectBot,
  onCreateBot,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: BotView[];
  onSelectBot: (botId: string) => void;
  onCreateBot: () => void;
  onOpenSettings: (botId: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        data-testid="search-palette"
        className="mx-auto mt-[228px] w-[640px] overflow-hidden rounded-xl border border-menu bg-raised shadow-menu"
        onClick={(event) => event.stopPropagation()}
      >
        <Command label="Search" loop>
          <div className="flex h-[72px] items-center gap-3 border-b border-hairline px-5">
            <HugeiconsIcon icon={Search01Icon} size={20} className="text-ink-muted" />
            <Command.Input
              autoFocus
              placeholder="Search Bots, Chats, Settings…"
              className="h-full flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <Command.List className="scroll-thin max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-base text-ink-muted">
              Nothing matches that.
            </Command.Empty>

            <Command.Group heading="Bots" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-ink-muted">
              {bots.map((bot) => (
                <Command.Item
                  key={bot.id}
                  value={`bot ${bot.name}`}
                  onSelect={() => {
                    onSelectBot(bot.id);
                    onOpenChange(false);
                  }}
                  className="flex h-[46px] cursor-default items-center gap-3 rounded-md px-3 text-body text-ink data-[selected=true]:bg-raised-3"
                >
                  <Avatar shape={bot.shape as never} color={bot.color} size={20} title="" />
                  <span>{bot.name}</span>
                  <span className="ml-2 truncate text-base text-ink-muted">
                    {bot.lastMessagePreview ?? "No messages yet"}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-ink-muted">
              <Command.Item
                value="new bot"
                onSelect={() => {
                  onCreateBot();
                  onOpenChange(false);
                }}
                className="flex h-9 items-center gap-2.5 rounded-md px-3 text-body data-[selected=true]:bg-raised-3"
              >
                <HugeiconsIcon icon={Add01Icon} size={16} />
                New Bot
              </Command.Item>
              <Command.Item
                value="settings"
                onSelect={() => {
                  if (bots[0]) onOpenSettings(bots[0].id);
                  onOpenChange(false);
                }}
                className="flex h-9 items-center gap-2.5 rounded-md px-3 text-body data-[selected=true]:bg-raised-3"
              >
                <HugeiconsIcon icon={Settings01Icon} size={16} />
                Settings
              </Command.Item>
              <Command.Item
                value="connect apps"
                className="flex h-9 items-center gap-2.5 rounded-md px-3 text-body data-[selected=true]:bg-raised-3"
              >
                <HugeiconsIcon icon={LinkSquare01Icon} size={16} />
                Connect Apps
                <span className="ml-auto text-sm text-ink-faint">P3</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Settings" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-ink-muted">
              <Command.Item
                value="theme dark"
                className="flex h-9 items-center gap-2.5 rounded-md px-3 text-body data-[selected=true]:bg-raised-3"
              >
                <HugeiconsIcon icon={Sun03Icon} size={16} />
                Theme: Dark
                <span className="ml-auto flex items-center gap-1 text-sm text-ink-muted">
                  <HugeiconsIcon icon={CheckmarkSquare02Icon} size={13} />
                  Current
                </span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
