"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ComputerIcon,
  PlayIcon,
  VoiceIcon,
} from "@hugeicons/core-free-icons";
import { Avatar } from "@pupbot/avatars/react";
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTab,
  toast,
} from "@pupbot/ui";
import { useState } from "react";
import type { BotView } from "../lib/types.ts";

interface ComputerCardState {
  label: string;
  detail?: string;
  dot: string | null;
  connect: boolean;
  thumbnail: string;
}

/** Provider, account and box id: support facts, never on the default path. */
function technicalDetails(bot: BotView): Array<{ label: string; value: string }> {
  const computer = bot.computer;
  const rows: Array<{ label: string; value: string }> = [];
  if (computer.provider) rows.push({ label: "Provider", value: computer.provider });
  if (computer.externalId) rows.push({ label: "Box", value: computer.externalId });
  if (computer.status) rows.push({ label: "Provider state", value: computer.status });
  return rows;
}

/** Truthful labels: every state says what it is, and a broken one says why. */
function computerCardState(bot: BotView): ComputerCardState {
  const computer = bot.computer;
  if (computer.binding === "unbound") {
    return { label: "No computer", dot: null, connect: true, thumbnail: "none" };
  }
  if (computer.binding === "binding") {
    return { label: "Connecting…", detail: "This takes a few seconds.", dot: "#8d8d8d", connect: false, thumbnail: "none" };
  }
  if (computer.binding === "blocked") {
    return {
      label: "Error",
      detail: computer.reason ?? undefined,
      dot: "#e5484d",
      connect: true,
      thumbnail: "none",
    };
  }
  switch (computer.status) {
    case "awake":
      return { label: "Awake", dot: "#00ba69", connect: false, thumbnail: "awake" };
    case "asleep":
      return { label: "Asleep", detail: "Wakes when you message it", dot: "#8d8d8d", connect: false, thumbnail: "asleep" };
    case "waking":
      return { label: "Waking…", dot: "#e2a336", connect: false, thumbnail: "asleep" };
    case "provisioning":
      return { label: "Starting…", dot: "#e2a336", connect: false, thumbnail: "asleep" };
    case "error":
      return {
        label: "Error",
        detail: computer.reason ?? "Rebuilds on the next message",
        dot: "#e5484d",
        connect: false,
        thumbnail: "none",
      };
    default:
      return { label: "Not connected", dot: null, connect: true, thumbnail: "none" };
  }
}

export function Rail({ bot, onClose, onConnect }: { bot: BotView; onClose: () => void; onConnect: () => void }) {
  const state = computerCardState(bot);
  const [advanced, setAdvanced] = useState(false);
  const tech = technicalDetails(bot);

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
            <div
              data-testid="computer-card"
              className="flex min-h-[62px] items-center gap-3 rounded-md bg-raised px-3 py-2"
            >
              <div className="relative flex h-[38px] w-[54px] flex-none items-center justify-center overflow-hidden rounded-sm bg-[#0b0b0b]">
                <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.08),transparent_65%)]" />
                <HugeiconsIcon icon={ComputerIcon} size={16} className="relative text-ink-faint" />
                {state.thumbnail !== "awake" ? (
                  <span className="absolute flex size-6 items-center justify-center rounded-pill bg-black/60">
                    <HugeiconsIcon icon={PlayIcon} size={11} className="text-ink" />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">Bot&apos;s computer</p>
                <p data-testid="computer-status" className="text-sm text-ink-muted">
                  {state.label}
                </p>
                {state.detail ? (
                  <p className="mt-0.5 line-clamp-2 text-sm text-ink-faint">{state.detail}</p>
                ) : null}
              </div>
              {state.connect ? (
                <button
                  type="button"
                  data-testid="rail-connect"
                  onClick={onConnect}
                  className="flex-none rounded-pill bg-raised-1 px-2.5 py-1 text-sm text-ink hover:bg-raised-2"
                >
                  {bot.computer.binding === "blocked" ? "Try again" : "Connect"}
                </button>
              ) : state.dot ? (
                <span className="size-2 flex-none rounded-pill" style={{ background: state.dot }} />
              ) : null}
            </div>
            {tech.length > 0 ? (
              <CollapsibleRoot open={advanced} onOpenChange={setAdvanced} className="mt-1">
                <CollapsibleTrigger
                  data-testid="computer-advanced"
                  className="rounded-pill px-1 py-1 text-sm text-ink-faint hover:text-ink-secondary"
                >
                  {advanced ? "Hide advanced" : "Advanced"}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <dl className="mt-1 space-y-1 rounded-md bg-raised px-3 py-2 text-sm">
                    {tech.map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-3">
                        <dt className="text-ink-muted">{row.label}</dt>
                        <dd className="truncate font-mono text-ink-secondary" title={row.value}>
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CollapsiblePanel>
              </CollapsibleRoot>
            ) : null}
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
