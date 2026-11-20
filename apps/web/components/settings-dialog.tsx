"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ComputerIcon,
  InformationCircleIcon,
  LockPasswordIcon,
  NotificationIcon,
  Settings01Icon,
  Shield01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import {
  Button,
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTitle,
  Select,
  Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTab,
  cn,
  toast,
} from "@pupbot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";
import type { BotView, ShellUser } from "../lib/types.ts";

const NAV = [
  { value: "general", label: "General", icon: Settings01Icon },
  { value: "computer", label: "Computer", icon: ComputerIcon },
  { value: "permissions", label: "Permissions", icon: Shield01Icon },
  { value: "vault", label: "Vault", icon: LockPasswordIcon },
  { value: "usage", label: "Usage & Billing", icon: NotificationIcon },
  { value: "updates", label: "Updates", icon: InformationCircleIcon },
] as const;

export function SettingsDialog({
  open,
  onOpenChange,
  user,
  bots,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ShellUser;
  bots: BotView[];
}) {
  const router = useRouter();
  const [sendWithCtrlEnter, setSendWithCtrlEnter] = useState(false);
  const [spellcheck, setSpellcheck] = useState(true);
  const [hardware, setHardware] = useState(true);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent width={1106} className="h-[756px] max-h-[92vh] overflow-hidden p-0" data-testid="settings-dialog">
        <TabsRoot defaultValue="general" orientation="vertical" className="flex h-full">
          <div className="flex w-[206px] flex-none flex-col bg-dialog-nav p-2">
            <p className="px-2 py-3 text-lg font-semibold text-ink">Settings</p>
            <TabsList className="flex flex-col items-stretch gap-0.5">
              {NAV.map((item) => (
                <TabsTab
                  key={item.value}
                  value={item.value}
                  className="h-10 justify-start gap-2.5 rounded-sm px-3 text-base font-normal text-ink-secondary data-[selected]:bg-raised data-[selected]:text-ink"
                >
                  <HugeiconsIcon icon={item.icon} size={16} strokeWidth={1.7} />
                  {item.label}
                </TabsTab>
              ))}
            </TabsList>
          </div>

          <div className="relative min-w-0 flex-1 overflow-y-auto scroll-thin p-[22px]">
            <DialogClose
              aria-label="Close settings"
              className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-pill text-ink-secondary hover:bg-raised"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </DialogClose>

            <TabsPanel value="general">
              <DialogTitle className="text-xl font-semibold">General</DialogTitle>

              <GroupLabel>Account</GroupLabel>
              <Card>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-10 items-center justify-center rounded-pill bg-raised text-body font-medium text-ink-secondary">
                    {user.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">{user.name}</p>
                    <p className="text-base text-ink-muted">{user.email}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => toast("Multiple accounts land in P3.")}>
                    Add account
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await authClient.signOut();
                      router.push("/sign-in");
                      router.refresh();
                    }}
                  >
                    Sign Out
                  </Button>
                </div>
              </Card>

              <GroupLabel>Appearance</GroupLabel>
              <Card>
                <Row label="Theme" helper="Light mode is coming.">
                  <Select
                    value="system"
                    onValueChange={() => toast("Dark theme is the only theme in v1.")}
                    options={[{ value: "system", label: "Follow System" }]}
                    disabled
                  />
                </Row>
                <Row label="Accent">
                  <span className="text-body text-ink-secondary">Bot color</span>
                </Row>
              </Card>

              <GroupLabel>System</GroupLabel>
              <Card>
                <Row label="Check Spelling While Typing">
                  <Switch checked={spellcheck} onCheckedChange={(value) => setSpellcheck(value)} />
                </Row>
                <Row
                  label="Send with Ctrl+Enter"
                  helper="Press Ctrl+Enter to send your message. Enter starts a new line."
                >
                  <Switch checked={sendWithCtrlEnter} onCheckedChange={(value) => setSendWithCtrlEnter(value)} />
                </Row>
                <Row label="Microphone">
                  <Select
                    value="system"
                    options={[{ value: "system", label: "System Default" }]}
                    disabled
                  />
                </Row>
                <Row label="Use hardware acceleration">
                  <Switch checked={hardware} onCheckedChange={(value) => setHardware(value)} />
                </Row>
              </Card>
            </TabsPanel>

            <TabsPanel value="computer">
              <DialogTitle className="text-xl font-semibold">Computer</DialogTitle>
              <GroupLabel>Providers</GroupLabel>
              <Card>
                <Row label="Instabox" helper="Pause and wake with processes preserved.">
                  <Status text="No account" />
                </Row>
                <Row label="Boat" helper="Cheaper per hour; a stop loses memory.">
                  <Status text="No account" />
                </Row>
                <Row label="Stub" helper="In-memory provider used until real ones are wired.">
                  <Status text="Active" tone="success" />
                </Row>
              </Card>
              <p className="mt-3 max-w-[520px] text-base text-ink-muted">
                Provider keys live in <span className="font-mono">.env</span> for now. Pooling many accounts,
                automatic allocation and the idle sweep land with the runtime phase.
              </p>
            </TabsPanel>

            <TabsPanel value="permissions">
              <DialogTitle className="text-xl font-semibold">Permissions</DialogTitle>
              <GroupLabel>Auto-review</GroupLabel>
              <Card>
                <div className="px-4 py-3">
                  <p className="text-body text-ink">Allow rules</p>
                  <p className="mt-1 text-base text-ink-muted">
                    Commands this bot may run without asking. The reviewer agent lands in P2.
                  </p>
                </div>
              </Card>
            </TabsPanel>

            <TabsPanel value="vault">
              <DialogTitle className="text-xl font-semibold">Vault</DialogTitle>
              <GroupLabel>Secrets</GroupLabel>
              <Card>
                <div className="px-4 py-4">
                  <p className="text-body text-ink-muted">
                    No secrets yet. Values are never shown again after saving.
                  </p>
                  <Button size="sm" variant="secondary" className="mt-3" onClick={() => toast("Secrets land in P2.")}>
                    Add secret
                  </Button>
                </div>
              </Card>
            </TabsPanel>

            <TabsPanel value="usage">
              <DialogTitle className="text-xl font-semibold">Usage &amp; Billing</DialogTitle>
              <GroupLabel>This period</GroupLabel>
              <Card>
                {bots.length === 0 ? (
                  <div className="px-4 py-3 text-body text-ink-muted">No bots yet.</div>
                ) : (
                  bots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="w-[120px] truncate text-body text-ink">{bot.name}</span>
                      <span className="h-1.5 flex-1 rounded-pill bg-raised-2">
                        <span className="block h-full w-0 rounded-pill bg-ink-secondary" />
                      </span>
                      <span className="text-sm tabular text-ink-muted">0 tokens</span>
                    </div>
                  ))
                )}
              </Card>
            </TabsPanel>

            <TabsPanel value="updates">
              <DialogTitle className="text-xl font-semibold">Updates</DialogTitle>
              <GroupLabel>Version</GroupLabel>
              <Card>
                <Row label="PupBot 0.1.0" helper="Development build.">
                  <Button size="sm" variant="secondary" onClick={() => toast("You are on the latest build.")}>
                    Check now
                  </Button>
                </Row>
              </Card>
            </TabsPanel>
          </div>
        </TabsRoot>
      </DialogContent>
    </DialogRoot>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 mt-6 px-1 text-base text-ink-muted">{children}</p>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-hairline overflow-hidden rounded-lg bg-raised">{children}</div>;
}

function Row({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[50px] items-center justify-between gap-4 px-4 py-2">
      <div>
        <p className="text-body text-ink">{label}</p>
        {helper ? <p className="text-sm text-ink-muted">{helper}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Status({ text, tone }: { text: string; tone?: "success" }) {
  return (
    <span className={cn("text-body", tone === "success" ? "text-success" : "text-ink-muted")}>{text}</span>
  );
}

export type { UserIcon };
