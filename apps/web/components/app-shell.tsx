"use client";

import { Button, toast } from "@terabot/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { giveComputer } from "../app/actions.ts";
import type { ShellData } from "../lib/types.ts";
import { AppsDialog } from "./apps-dialog.tsx";
import { BotSettingsDialog } from "./bot-settings-dialog.tsx";
import { Chat } from "./chat.tsx";
import { CreateBotDialog } from "./create-bot-dialog.tsx";
import { PrimaryBotDialog } from "./primary-bot-dialog.tsx";
import { Rail } from "./rail.tsx";
import { SearchPalette } from "./search-palette.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";
import { Sidebar } from "./sidebar.tsx";

export function AppShell({ data }: { data: ShellData }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [createOpen, setCreateOpen] = useState(data.bots.length === 0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(searchParams.get("apps") === "1");
  const [settingsSection, setSettingsSection] = useState("general");

  const openProviders = useCallback(() => {
    setSettingsSection("providers");
    setSettingsOpen(true);
  }, []);

  const activeBot = data.activeBot;
  const settingsBot = useMemo(
    () => data.bots.find((bot) => bot.id === settingsBotId) ?? null,
    [data.bots, settingsBotId],
  );

  const selectBot = useCallback(
    (botId: string) => {
      if (botId === activeBot?.id) return;
      router.push(`/b/${botId}`);
    },
    [activeBot?.id, router],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onGiveComputer = useCallback(async () => {
    if (!activeBot) return;
    try {
      const result = await giveComputer(activeBot.id);
      // A refusal comes back as a value with its reason; saying it out loud is
      // the whole point, so it is surfaced rather than swallowed.
      if (result && "ok" in result && result.ok === false) {
        toast(`${result.notice.situation} ${result.notice.resolution}`);
      }
      router.refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not connect a computer.");
      router.refresh();
    }
  }, [activeBot, router]);

  const computerBinding = activeBot?.computer.binding;
  const computerStatus = activeBot?.computer.status;

  useEffect(() => {
    // While a box is being allocated or woken, the server has the truth; ask it.
    const working = computerBinding === "binding" || computerStatus === "waking" || computerStatus === "provisioning";
    if (!working) return;
    const timer = setInterval(() => router.refresh(), 1200);
    return () => clearInterval(timer);
  }, [computerBinding, computerStatus, router]);

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-canvas"
      style={{ ["--accent" as string]: activeBot?.accentColor ?? "#1884fc" }}
    >
      <Sidebar
        user={data.user}
        bots={data.bots}
        sections={data.sections}
        activeBotId={activeBot?.id ?? null}
        onSelect={selectBot}
        onCreateBot={() => setCreateOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        onChoosePrimary={() => setPrimaryOpen(true)}
        onOpenSettings={(botId) => setSettingsBotId(botId)}
        onOpenAccount={() => setSettingsOpen(true)}
        onOpenSettingsDialog={() => setSettingsOpen(true)}
        onOpenApps={() => setAppsOpen(true)}
      />

      {activeBot ? (
        <Chat
          key={activeBot.id}
          bot={activeBot}
          apiUrl={data.apiUrl}
          initialMessages={data.messages}
          activeRunId={data.activeRunId}
          pendingRequest={data.pendingRequest}
          onManageProviders={openProviders}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center bg-canvas">
          <div className="max-w-[380px] text-center">
            <p className="text-xl font-semibold text-ink">No bots yet</p>
            <p className="mt-2 text-body text-ink-secondary">
              A bot is a named avatar with its own computer and one conversation. Make the first one.
            </p>
            <Button variant="primary" className="mt-4" onClick={() => setCreateOpen(true)}>
              Create a bot
            </Button>
          </div>
        </div>
      )}

      {activeBot && railOpen ? (
        <Rail bot={activeBot} onClose={() => setRailOpen(false)} onConnect={onGiveComputer} />
      ) : null}

      <CreateBotDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        endpoints={data.endpoints}
        onManageProviders={openProviders}
      />
      <PrimaryBotDialog open={primaryOpen} onOpenChange={setPrimaryOpen} bots={data.bots} />
      <SearchPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        bots={data.bots}
        onSelectBot={selectBot}
        onCreateBot={() => setCreateOpen(true)}
        onOpenSettings={(botId) => setSettingsBotId(botId)}
      />
      <SettingsDialog
        key={settingsSection}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={data.user}
        bots={data.bots}
        usage={data.usage}
        endpoints={data.endpoints}
        computerAccounts={data.computerAccounts}
        computerProviders={data.computerProviders}
        apiUrl={data.apiUrl}
        initialSection={settingsSection}
      />
      <AppsDialog open={appsOpen} onOpenChange={setAppsOpen} initialConnections={data.connections} />
      {settingsBot ? (
        <BotSettingsDialog
          bot={settingsBot}
          endpoints={data.endpoints}
          connections={data.connections}
          open={Boolean(settingsBotId)}
          onOpenChange={(open) => setSettingsBotId(open ? settingsBotId : null)}
          onManageProviders={openProviders}
        />
      ) : null}
    </div>
  );
}
