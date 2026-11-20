"use client";

import { COLORS, type AvatarColorId, type AvatarShapeId } from "@pupbot/avatars";
import { Avatar } from "@pupbot/avatars/react";
import {
  Button,
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTitle,
  Input,
  Select,
  Textarea,
  cn,
  toast,
} from "@pupbot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { addModelEndpoint, deleteBot, giveComputer, setBotFlags, updateBotSettings } from "../app/actions.ts";
import type { BotView, EndpointView } from "../lib/types.ts";
import { AvatarPicker } from "./avatar-picker.tsx";

export function BotSettingsDialog({
  bot,
  endpoints,
  open,
  onOpenChange,
}: {
  bot: BotView;
  endpoints: EndpointView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [shape, setShape] = useState<AvatarShapeId>(bot.shape as AvatarShapeId);
  const [color, setColor] = useState<AvatarColorId>(bot.color as AvatarColorId);
  const [endpointId, setEndpointId] = useState<string | null>(bot.endpointId ?? bot.endpointId);
  const [modelId, setModelId] = useState(endpoints.find((entry) => entry.id === bot.endpointId)?.modelId ?? "");
  const [pending, setPending] = useState(false);

  const [addingEndpoint, setAddingEndpoint] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [endpointModel, setEndpointModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [endpointResult, setEndpointResult] = useState<string | null>(null);

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
              <span className="text-body">Endpoint</span>
              <Select
                value={endpointId ?? undefined}
                onValueChange={(value) => {
                  setEndpointId(value);
                  const next = endpoints.find((entry) => entry.id === value);
                  if (next) setModelId(next.modelId);
                }}
                placeholder="Pick an endpoint"
                options={endpoints.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-hairline px-4 py-3">
              <span className="text-body">Model ID</span>
              <Input
                aria-label="Model ID"
                className="h-8 w-[240px] text-right"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
            </div>
            <div className="flex items-center justify-between border-t border-hairline px-4 py-3">
              <span className="text-body">Context</span>
              <span className="text-body text-ink-muted">
                {endpoint?.contextWindow ? `${endpoint.contextWindow.toLocaleString()} tokens` : "Unknown"}
              </span>
            </div>
            <div className="border-t border-hairline p-4">
              {addingEndpoint ? (
                <div className="space-y-2">
                  <Input
                    aria-label="Base URL"
                    placeholder="https://api.openai.com/v1"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                  <Input
                    aria-label="Model to add"
                    placeholder="gpt-5.6-sol"
                    value={endpointModel}
                    onChange={(event) => setEndpointModel(event.target.value)}
                  />
                  <Input
                    aria-label="API key"
                    type="password"
                    placeholder="API key (kept encrypted)"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        const result = await addModelEndpoint({
                          label: endpointModel,
                          kind: "openai-chat",
                          baseUrl,
                          modelId: endpointModel,
                          apiKey: apiKey || undefined,
                        });
                        setEndpointId(result.endpointId);
                        setModelId(endpointModel);
                        setEndpointResult(
                          result.match === "matched"
                            ? `Matched in models.dev: ${result.modelName ?? endpointModel}, ${result.contextWindow?.toLocaleString() ?? "unknown"} tokens.`
                            : "Saved, but models.dev has no entry for this model — it will work, context and pricing stay unknown.",
                        );
                        setAddingEndpoint(false);
                        router.refresh();
                      }}
                    >
                      Add endpoint
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAddingEndpoint(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-body text-ink-secondary underline underline-offset-2 hover:text-ink"
                  onClick={() => setAddingEndpoint(true)}
                >
                  Add a base URL + key + model
                </button>
              )}
              {endpointResult ? <p className="mt-2 text-sm text-ink-muted">{endpointResult}</p> : null}
            </div>
          </Group>

          <Group label="Computer">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-body">{bot.computer ? "Computer" : "No computer bound"}</span>
              <span className="text-body text-ink-muted">
                {bot.computer ? (bot.computer.status === "awake" ? "Awake" : "Asleep") : "Chat is blocked"}
              </span>
            </div>
            {bot.computer ? (
              <div className="border-t border-hairline px-4 py-3 text-sm text-ink-muted">
                Provider {bot.computer.provider} · {bot.computer.status}
              </div>
            ) : (
              <div className="border-t border-hairline p-4">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    await giveComputer(bot.id);
                    router.refresh();
                    toast("Computer attached");
                  }}
                >
                  Give it a computer
                </Button>
              </div>
            )}
          </Group>

          <Group label="Danger">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-body text-ink">Delete {bot.name}</p>
                <p className="text-sm text-ink-muted">
                  Its conversation, memory and routines are removed. Its computer returns to the pool.
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
