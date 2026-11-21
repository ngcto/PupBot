"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Delete02Icon,
  EyeOffIcon,
  FolderAddIcon,
  PencilEdit02Icon,
  PinIcon,
  Search01Icon,
  Settings01Icon,
  VoiceIcon,
  WindowsNewIcon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@terabot/avatars/react";
import {
  ContextMenuArea,
  ContextMenuItem,
  ContextMenuSeparator,
  Tooltip,
  cn,
  toast,
} from "@terabot/ui";
import { useState } from "react";
import { deleteBot, moveBotToSection, setBotFlags } from "../app/actions.ts";
import { previewText } from "../lib/format.ts";
import type { BotView, SectionView, ShellUser } from "../lib/types.ts";
import { AccountMenu } from "./account-menu.tsx";

interface SidebarProps {
  user: ShellUser;
  bots: BotView[];
  sections: SectionView[];
  activeBotId: string | null;
  onSelect: (botId: string) => void;
  onCreateBot: () => void;
  onOpenPalette: () => void;
  onChoosePrimary: () => void;
  onOpenSettings: (botId: string) => void;
  onOpenAccount: () => void;
  onOpenSettingsDialog: () => void;
  onOpenApps: () => void;
}

export function Sidebar({
  user,
  bots,
  sections,
  activeBotId,
  onSelect,
  onCreateBot,
  onOpenPalette,
  onChoosePrimary,
  onOpenSettings,
  onOpenSettingsDialog,
  onOpenApps,
}: SidebarProps) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const visible = bots.filter((bot) => !bot.hidden);
  const hidden = bots.filter((bot) => bot.hidden);
  const primary = bots.find((bot) => bot.isPrimary) ?? visible[0] ?? bots[0] ?? null;

  const pinned = visible.filter((bot) => bot.pinned && !bot.sectionId);
  const ungrouped = visible.filter((bot) => !bot.pinned && !bot.sectionId);

  return (
    <aside
      data-testid="sidebar"
      className="flex h-full flex-none flex-col border-r border-hairline bg-app"
      style={{ width: 298 }}
    >
      <div className="flex justify-end gap-2.5 pr-[17px] pt-3">
        <Tooltip content="Search · ⌘K">
          <button
            type="button"
            aria-label="Search"
            onClick={onOpenPalette}
            className="flex size-9 items-center justify-center rounded-pill bg-raised text-ink-secondary transition-colors hover:bg-raised-2 hover:text-ink active:scale-[0.97]"
          >
            <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip content="New bot · ⌘⇧N">
          <button
            type="button"
            aria-label="New bot"
            onClick={onCreateBot}
            className="flex size-9 items-center justify-center rounded-pill bg-raised text-ink-secondary transition-colors hover:bg-raised-2 hover:text-ink active:scale-[0.97]"
          >
            <HugeiconsIcon icon={Add01Icon} size={16} strokeWidth={1.9} />
          </button>
        </Tooltip>
      </div>

      {primary ? (
        <div className="flex flex-col items-center pb-1 pt-[26px]">
          <ContextMenuArea items={<PrimaryMenu bot={primary} onChoosePrimary={onChoosePrimary} />}>
            <button
              type="button"
              data-testid="primary-bot"
              aria-label={`Open ${primary.name}`}
              onClick={() => onSelect(primary.id)}
              className="flex flex-col items-center gap-1"
            >
              <Avatar shape={primary.shape as never} color={primary.color} size={58} title="" />
              <span className="text-base font-semibold text-ink-dim">{primary.name}</span>
            </button>
          </ContextMenuArea>
        </div>
      ) : null}

      <div className="scroll-thin mt-[26px] flex-1 overflow-y-auto px-3">
        {bots.length === 0 ? (
          <p className="px-2 py-3 text-base text-ink-muted">No bots yet. Create one to get started.</p>
        ) : null}

        {pinned.map((bot) => (
          <BotRow key={bot.id} bot={bot} active={bot.id === activeBotId} onSelect={onSelect} onOpenSettings={onOpenSettings} />
        ))}

        {sections.map((section) => {
          const members = visible.filter((bot) => bot.sectionId === section.id);
          if (members.length === 0) return null;
          return (
            <div key={section.id} className="mt-4">
              <p className="mb-1 px-2 text-sm text-ink-muted">{section.name}</p>
              {members.map((bot) => (
                <BotRow key={bot.id} bot={bot} active={bot.id === activeBotId} onSelect={onSelect} onOpenSettings={onOpenSettings} />
              ))}
            </div>
          );
        })}

        <div className="mt-3">
          {ungrouped.map((bot) => (
            <BotRow key={bot.id} bot={bot} active={bot.id === activeBotId} onSelect={onSelect} onOpenSettings={onOpenSettings} />
          ))}
        </div>

        {hidden.length > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setHiddenOpen((open) => !open)}
              className="flex h-8 w-full items-center justify-between px-2 text-sm text-ink-muted hover:text-ink-secondary"
            >
              <span>Hidden Bots</span>
              <span className="flex items-center gap-1.5">
                {hiddenOpen ? null : <span className="tabular">{hidden.length}</span>}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  className={cn("transition-transform", hiddenOpen ? "rotate-180" : "")}
                />
              </span>
            </button>
            {hiddenOpen
              ? hidden.map((bot) => (
                  <BotRow
                    key={bot.id}
                    bot={bot}
                    active={bot.id === activeBotId}
                    onSelect={onSelect}
                    onOpenSettings={onOpenSettings}
                    hiddenRow
                  />
                ))
              : null}
          </div>
        ) : null}
      </div>

      <div className="flex h-[52px] items-center gap-2.5 px-3 pb-[8px]">
        <AccountMenu user={user} onOpenSettings={onOpenSettingsDialog}>
          <button
            type="button"
            aria-label="Account"
            className="flex size-[34px] items-center justify-center rounded-pill bg-raised text-base font-medium text-ink-secondary hover:bg-raised-2"
          >
            {user.name.slice(0, 1).toUpperCase()}
          </button>
        </AccountMenu>

        <button
          type="button"
          onClick={onOpenApps}
          aria-label="Connect apps"
          data-testid="connect-apps"
          className="flex h-[34px] flex-1 items-center gap-2 rounded-pill bg-raised px-2.5 text-base text-ink hover:bg-raised-2"
        >
          <span>Connect apps</span>
          <span className="ml-auto flex h-5 items-center gap-1 rounded-[5px] bg-white px-1">
            <span className="block size-3 rounded-[2px] bg-[#1a73e8]" />
            <span className="block size-3 rounded-[2px] bg-[#ea4335]" />
            <span className="block size-3 rounded-[2px] bg-[#34a853]" />
          </span>
        </button>

        <Tooltip content="Voice chat">
          <button
            type="button"
            aria-label="Voice chat"
            onClick={() => toast("Voice chat lands in P2.")}
            className="flex size-[34px] items-center justify-center rounded-pill bg-raised text-ink-secondary hover:bg-raised-2 hover:text-[#1884fc]"
          >
            <HugeiconsIcon icon={VoiceIcon} size={16} strokeWidth={1.7} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

function BotRow({
  bot,
  active,
  onSelect,
  onOpenSettings,
  hiddenRow,
}: {
  bot: BotView;
  active: boolean;
  onSelect: (botId: string) => void;
  onOpenSettings: (botId: string) => void;
  hiddenRow?: boolean;
}) {
  return (
    <ContextMenuArea items={<RowMenu bot={bot} onOpenSettings={onOpenSettings} hiddenRow={hiddenRow} />}>
      <button
        type="button"
        data-testid={`bot-row-${bot.id}`}
        data-active={active ? "true" : "false"}
        onClick={() => onSelect(bot.id)}
        className={cn(
          "mb-1.5 flex h-[52px] w-full items-center gap-[13px] rounded-md px-[7px] text-left transition-colors",
          active ? "bg-raised" : "hover:bg-raised/60",
        )}
      >
        <span className="relative">
          <Avatar shape={bot.shape as never} color={bot.color} size={32} title="" />
          {bot.unread ? (
            <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-pill border-2 border-app" style={{ background: bot.accentColor }} />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-base font-semibold text-ink">{bot.name}</span>
            {bot.pinned ? <HugeiconsIcon icon={PinIcon} size={11} className="text-ink-faint" /> : null}
          </span>
          <span className="mt-0.5 block truncate text-sm text-ink-secondary">
            {bot.lastMessagePreview
              ? previewText(bot.lastMessagePreview, 44)
              : "Nothing's here yet. Send me something to work on…"}
          </span>
        </span>
      </button>
    </ContextMenuArea>
  );
}

function PrimaryMenu({ bot, onChoosePrimary }: { bot: BotView; onChoosePrimary: () => void }) {
  return (
    <>
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { pinned: !bot.pinned })}>
        <Icon icon={PinIcon} />
        {bot.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { unread: true })}>
        <Icon icon={EyeOffIcon} />
        Mark as Unread
      </ContextMenuItem>
      <ContextMenuItem onClick={() => window.open(`/b/${bot.id}`, "_blank")}>
        <Icon icon={WindowsNewIcon} />
        New window
      </ContextMenuItem>
      <ContextMenuItem onClick={() => copyConversationId(bot.conversationId)}>
        <Icon icon={Copy01Icon} />
        Copy conversation ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { hidden: true })}>
        <Icon icon={EyeOffIcon} />
        Hide from sidebar
      </ContextMenuItem>
      <ContextMenuItem onClick={onChoosePrimary}>
        <Icon icon={Settings01Icon} />
        Replace with different Bot
      </ContextMenuItem>
    </>
  );
}

function RowMenu({
  bot,
  onOpenSettings,
  hiddenRow,
}: {
  bot: BotView;
  onOpenSettings: (botId: string) => void;
  hiddenRow?: boolean;
}) {
  return (
    <>
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { pinned: !bot.pinned })}>
        <Icon icon={PinIcon} />
        {bot.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void moveBotToSection(bot.id, { newSectionName: "New section" })}>
        <Icon icon={FolderAddIcon} />
        Move to new section
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { unread: true })}>
        <Icon icon={EyeOffIcon} />
        Mark as Unread
      </ContextMenuItem>
      <ContextMenuItem onClick={() => window.open(`/b/${bot.id}`, "_blank")}>
        <Icon icon={WindowsNewIcon} />
        New window
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onOpenSettings(bot.id)}>
        <Icon icon={PencilEdit02Icon} />
        Rename Bot
      </ContextMenuItem>
      <ContextMenuItem onClick={() => copyConversationId(bot.conversationId)}>
        <Icon icon={Copy01Icon} />
        Copy conversation ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void setBotFlags(bot.id, { hidden: !bot.hidden })}>
        <Icon icon={EyeOffIcon} />
        {hiddenRow ? "Show in sidebar" : "Hide from sidebar"}
      </ContextMenuItem>
      <ContextMenuItem
        className="text-danger data-[highlighted]:bg-danger/10"
        onClick={() => {
          if (window.confirm(`Delete ${bot.name}? Its conversation is removed too.`)) {
            void deleteBot(bot.id);
          }
        }}
      >
        <Icon icon={Delete02Icon} className="text-danger" />
        Delete
      </ContextMenuItem>
    </>
  );
}

function Icon({ icon, className }: { icon: typeof PinIcon; className?: string }) {
  return <HugeiconsIcon icon={icon} size={16} strokeWidth={1.7} className={className} />;
}

function copyConversationId(conversationId: string) {
  void navigator.clipboard.writeText(conversationId);
  toast("Conversation ID copied");
}
