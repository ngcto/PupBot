"use client";

import { COLORS, type AvatarColorId, type AvatarShapeId } from "@terabot/avatars";
import { Avatar } from "@terabot/avatars/react";
import {
  Button,
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTitle,
  Input,
  Select,
  Switch,
  Textarea,
  cn,
  toast,
} from "@terabot/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { deleteBot, giveComputer, setBotFlags, testModelEndpoint, updateBotSettings } from "../app/actions.ts";
import type { TestEndpointResult } from "../app/actions.ts";
import { loadConnections, toggleBotApp } from "../app/apps/actions.ts";
import type { BotView, ConnectedApp, EndpointView } from "../lib/types.ts";
import { AvatarPicker } from "./avatar-picker.tsx";
import { TestResultLine } from "./provider-form.tsx";
import { ModelPicker } from "./model-picker.tsx";

export function BotSettingsDialog({
  bot,
  endpoints,
  connections,
  open,
  onOpenChange,
  onManageProviders,
}: {
  bot: BotView;
  endpoints: EndpointView[];
  /** Connected apps, as the page last read them; refreshed when the panel opens. */
  connections: ConnectedApp[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Settings > Providers; the bot dialog never takes a key itself. */
  onManageProviders: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [shape, setShape] = useState<AvatarShapeId>(bot.shape as AvatarShapeId);
  const [color, setColor] = useState<AvatarColorId>(bot.color as AvatarColorId);
  const [endpointId, setEndpointId] = useState<string | null>(bot.endpointId);
  const [modelId, setModelId] = useState(endpoints.find((entry) => entry.id === bot.endpointId)?.modelId ?? "");
  const [pending, setPending] = useState(false);

  const [testingEndpoint, setTestingEndpoint] = useState(false);
  const [endpointTest, setEndpointTest] = useState<TestEndpointResult | null>(null);
  const [modelDetails, setModelDetails] = useState(false);
  const testToken = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("terabot:model-details") === "1") setModelDetails(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("terabot:model-details", modelDetails ? "1" : "0");
  }, [modelDetails]);

  const [allowed, setAllowed] = useState<string[]>(bot.appIds);
  const [apps, setApps] = useState<ConnectedApp[]>(
    connections.filter((connection) => connection.status === "active"),
  );

  // Read the connections when the panel opens rather than trusting the page-level
  // snapshot: an app linked a moment ago belongs here immediately.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadConnections().then((next) => {
      if (live) setApps(next.filter((connection) => connection.status === "active"));
    });
    return () => {
      live = false;
    };
  }, [open]);

  const accent = COLORS.find((entry) => entry.id === color)?.hex ?? bot.accentColor;
  const endpoint = endpoints.find((entry) => entry.id === endpointId);

  async function save() {
    setPending(true);
    await updateBotSettings(bot.id, {
      name,
      instructions,
      shape,
      color,
      accentColor: accent,
      endpointId: endpointId ?? null,
      modelId: modelId || null,
    });
    setPending(false);
    onOpenChange(false);
    router.refresh();
    toast("Saved");
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent width={680} data-testid="bot-settings-dialog" className="max-h-[86vh]">
        <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-hairline bg-dialog px-4">
          <DialogTitle className="text-lg font-semibold">{bot.name}</DialogTitle>
          <DialogClose aria-label="Close" className="text-ink-secondary hover:text-ink">
            ✕
          </DialogClose>
        </div>

        <div className="flex flex-col gap-6 px-5 py-5">
          <Group label="Identity">
            <div className="flex items-start gap-4 p-4">
              <Avatar shape={shape} color={color} size={64} title="" />
              <div className="flex-1 space-y-3">
                <Input aria-label="Bot name" value={name} onChange={(event) => setName(event.target.value)} />
                <Textarea
                  aria-label="Instructions"
                  rows={4}
                  placeholder="How should this bot behave?"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
            </div>
            <div className="border-t border-hairline p-4">
              <AvatarPicker shape={shape} color={color} onShape={setShape} onColor={setColor} />
            </div>
          </Group>

          <Group label="Model">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-body">Provider</span>
              <div className="flex items-center gap-2">
                <Select
                  value={endpointId ?? undefined}
                  onValueChange={(value) => {
                    testToken.current += 1;
                    setTestingEndpoint(false);
                    setEndpointId(value);
                    setEndpointTest(null);
                    const next = endpoints.find((entry) => entry.id === value);
                    if (next) setModelId(next.modelId);
                  }}
                  placeholder="Pick a provider"
                  options={endpoints.map((entry) => ({ value: entry.id, label: entry.label }))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!endpointId || testingEndpoint}
                  onClick={async () => {
                    if (!endpointId) return;
                    const token = ++testToken.current;
                    setTestingEndpoint(true);
                    setEndpointTest(null);
                    try {
                      const result = await testModelEndpoint({ endpointId, modelId: modelId || undefined });
                      // A slower response for an older endpoint/model must not
                      // overwrite a newer selection's empty result.
                      if (token === testToken.current) setEndpointTest(result);
                    } finally {
                      if (token === testToken.current) setTestingEndpoint(false);
                    }
                  }}
                >
                  {testingEndpoint ? "Testing…" : "Test"}
                </Button>
              </div>
            </div>
            <div className="border-t border-hairline px-4 py-3">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-sm text-ink-muted">Model</p>
                <button
                  type="button"
                  className="text-sm text-ink-faint hover:text-ink"
                  onClick={() => setModelDetails((value) => !value)}
                >
                  {modelDetails ? "Hide details" : "Details"}
                </button>
              </div>
              <ModelPicker
                value={modelId}
                onChange={(next) => {
                  testToken.current += 1;
                  setTestingEndpoint(false);
                  setModelId(next);
                  setEndpointTest(null);
                }}
                providerHint={endpoint?.providerHint ?? null}
                details={modelDetails}
                endpointId={endpoint?.id}
              />
            </div>
            {endpointTest ? (
              <div className="border-t border-hairline px-4 py-2">
                <TestResultLine result={endpointTest} />
              </div>
            ) : null}
            <div className="border-t border-hairline px-4 py-3">
              {endpoints.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No provider configured yet.{" "}
                  <button
                    type="button"
                    className="text-ink-secondary underline underline-offset-2 hover:text-ink"
                    onClick={onManageProviders}
                  >
                    Add one in Settings → Providers
                  </button>
                  .
                </p>
              ) : (
                <button
                  type="button"
                  className="text-sm text-ink-faint underline underline-offset-2 hover:text-ink"
                  onClick={onManageProviders}
                >
                  Manage providers in Settings
                </button>
              )}
            </div>
          </Group>

          <Group label="Apps">
            {apps.length === 0 ? (
              <div className="px-4 py-3" data-testid="bot-apps-empty">
                <p className="text-body text-ink">No apps connected yet</p>
                <p className="mt-1 text-sm text-ink-muted">
                  Use “Connect apps” at the bottom of the sidebar to link an account. Apps you connect
                  appear here, and you choose which ones this bot may use.
                </p>
              </div>
            ) : (
              <>
                {apps.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-3 last:border-b-0"
                    data-testid={`bot-app-${connection.toolkit}`}
                  >
                    <span className="text-body text-ink">{connection.name}</span>
                    <Switch
                      aria-label={`Let ${bot.name} use ${connection.name}`}
                      checked={allowed.includes(connection.id)}
                      onCheckedChange={async (checked) => {
                        const result = await toggleBotApp(bot.id, connection.id, checked);
                        if (result.error) {
                          toast(result.error);
                          return;
                        }
                        setAllowed((current) =>
                          checked ? [...current, connection.id] : current.filter((id) => id !== connection.id),
                        );
                        router.refresh();
                      }}
                    />
                  </div>
                ))}
                <p className="border-t border-hairline px-4 py-3 text-sm leading-relaxed text-ink-muted">
                  Saved for this bot. Nothing uses it in a chat yet: the harness has no tool-calling
                  loop, so a connected app is a stored, revocable link and nothing more.
                </p>
              </>
            )}
          </Group>

          <Group label="Computer">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-body">{bot.computer.externalId ? "Computer" : "No computer yet"}</span>
              <span className="text-body text-ink-muted">
                {bot.computer.externalId
                  ? bot.computer.status === "awake"
                    ? "Awake"
                    : "Asleep"
                  : "Built on first use"}
              </span>
            </div>
            {bot.computer.externalId ? (
              <div className="border-t border-hairline px-4 py-3 text-sm text-ink-muted">
                Provider {bot.computer.provider} · {bot.computer.status}
              </div>
            ) : (
              <div className="border-t border-hairline px-4 py-3">
                <p className="text-sm text-ink-muted">
                  Nothing to set up: the first thing this bot actually does with a computer builds one.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={async () => {
                    await giveComputer(bot.id);
                    router.refresh();
                    toast("Building a computer");
                  }}
                >
                  Build it now
                </Button>
              </div>
            )}
          </Group>

          <Group label="Danger">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-body text-ink">Delete {bot.name}</p>
                <p className="text-sm text-ink-muted">
                  Its conversation, memory and routines are removed, and its computer is destroyed now so it stops billing.
                </p>
              </div>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await deleteBot(bot.id);
                  onOpenChange(false);
                  router.push("/");
                  router.refresh();
                }}
              >
                Delete
              </Button>
            </div>
          </Group>
        </div>

        <div className="sticky bottom-0 flex h-16 items-center justify-between gap-2 border-t border-hairline bg-dialog px-4">
          <button
            type="button"
            className="text-sm text-ink-muted hover:text-ink"
            onClick={async () => {
              await setBotFlags(bot.id, { hidden: !bot.hidden });
              router.refresh();
            }}
          >
            {bot.hidden ? "Show in sidebar" : "Hide from sidebar"}
          </button>
          <div className="flex items-center gap-2">
            <DialogClose className={cn("h-9 rounded-pill px-4 text-base font-medium text-ink hover:bg-raised")}>
              Cancel
            </DialogClose>
            <Button variant="primary" className="h-9 px-4" disabled={!name.trim() || pending} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 px-1 text-base text-ink-muted">{label}</p>
      <div className="overflow-hidden rounded-lg bg-raised">{children}</div>
    </section>
  );
}
