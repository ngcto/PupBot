"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ComputerIcon,
  PlayIcon,
  VoiceIcon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@pupbot/avatars/react";
import { TabsList, TabsPanel, TabsRoot, TabsTab, toast } from "@pupbot/ui";
import type { BotView } from "../lib/types.ts";

export function Rail({ bot, onClose }: { bot: BotView; onClose: () => void }) {
  return (
    <aside
      data-testid="rail"
      className="flex h-full flex-none flex-col border-l border-divider bg-canvas"
      style={{ width: 319 }}
    >
      <div className="flex items-center justify-end pt-4 pr-4">
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-pill bg-raised text-ink-secondary hover:bg-raised-2 hover:text-ink"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-col items-center px-4">
        <Avatar shape={bot.shape as never} color={bot.color} size={64} title="" />
        <p className="mt-2 text-lg font-semibold text-ink">{bot.name}</p>
      </div>

      <TabsRoot defaultValue="activity" className="mt-5 flex min-h-0 flex-1 flex-col px-4">
        <TabsList className="justify-center">
          <TabsTab value="activity">Activity</TabsTab>
          <TabsTab value="library">Library</TabsTab>
        </TabsList>

        <TabsPanel value="activity" className="scroll-thin mt-5 min-h-0 flex-1 overflow-y-auto">
          <section>
            <p className="mb-2 text-sm font-medium tracking-[0.02em] text-ink-muted">Suggested</p>
            <div className="rounded-md bg-raised px-3.5 py-3" style={{ minHeight: 106 }}>
              <p className="text-body font-medium text-ink">Put {bot.name} on a schedule</p>
              <p className="mt-1 text-sm leading-[18px] text-ink-muted">
                Routines run a prompt for you on a cron — a morning digest, a nightly check.
              </p>
              <button
                type="button"
                onClick={() => toast("Routines land in P2.")}
                className="mt-2.5 rounded-pill bg-raised-1 px-3 py-1.5 text-base text-ink hover:bg-raised-2"
              >
                Create a routine
              </button>
            </div>
          </section>

          <section className="mt-5">
            <p className="mb-2 text-sm font-medium tracking-[0.02em] text-ink-muted">Computer</p>
            <div className="flex h-[62px] items-center gap-3 rounded-md bg-raised px-3">
              <div className="relative flex h-[38px] w-[54px] items-center justify-center overflow-hidden rounded-sm bg-[#0b0b0b]">
                <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.08),transparent_65%)]" />
                <HugeiconsIcon icon={ComputerIcon} size={16} className="relative text-ink-faint" />
                {bot.computer?.status === "asleep" ? (
                  <span className="absolute flex size-6 items-center justify-center rounded-pill bg-black/60">
                    <HugeiconsIcon icon={PlayIcon} size={11} className="text-ink" />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">Bot&apos;s computer</p>
                <p className="text-sm text-ink-muted">
                  {bot.computer ? (bot.computer.status === "awake" ? "Awake" : "Asleep") : "Not connected"}
                </p>
              </div>
              {bot.computer ? (
                <span
                  className="size-2 rounded-pill"
                  style={{ background: bot.computer.status === "awake" ? "#00ba69" : "#8d8d8d" }}
                />
              ) : null}
            </div>
          </section>

          <section className="mt-5">
            <p className="mb-2 text-sm font-medium tracking-[0.02em] text-ink-muted">Voice chat</p>
            <div className="flex flex-col gap-2">
              <div className="flex h-[46px] items-center justify-between rounded-md bg-raised px-3">
                <span className="flex items-center gap-2 text-body text-ink">
                  <HugeiconsIcon icon={VoiceIcon} size={15} className="text-ink-muted" />
                  Voice
                </span>
                <span className="text-body text-ink-secondary">Liora · 1.0x</span>
              </div>
              <div className="flex h-[46px] items-center justify-between rounded-md bg-raised px-3">
                <span className="text-body text-ink">Language</span>
                <span className="text-body text-ink-secondary">Auto-detect</span>
              </div>
            </div>
          </section>

          <section className="mb-6 mt-5">
            <p className="mb-2 text-sm font-medium tracking-[0.02em] text-ink-muted">This week</p>
            <p className="text-body text-ink-muted">Nothing here yet.</p>
          </section>
        </TabsPanel>

        <TabsPanel value="library" className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <p className="text-body text-ink-muted">
            Nothing here yet. Files it makes will show up here.
          </p>
        </TabsPanel>
      </TabsRoot>
    </aside>
  );
}
