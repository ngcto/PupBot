"use client";

import { COLORS, type AvatarColorId, type AvatarShapeId, SHAPES } from "@terabot/avatars";
import { Avatar } from "@terabot/avatars/react";
import { Button, DialogClose, DialogContent, DialogRoot, DialogTitle, Input, Select, cn } from "@terabot/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createBot } from "../app/actions.ts";
import type { EndpointView } from "../lib/types.ts";
import { AvatarPicker } from "./avatar-picker.tsx";
import { ModelPicker } from "./model-picker.tsx";

function randomShape(): AvatarShapeId {
  return SHAPES[Math.floor(Math.random() * SHAPES.length)]!.id;
}

function randomColor(): AvatarColorId {
  return COLORS[Math.floor(Math.random() * COLORS.length)]!.id;
}

/**
 * Creating a bot is a name, a face, and a choice of what is already configured:
 * a provider from Settings and one of its models. Nothing technical is asked for
 * here, and with no provider yet the dialog says where to add one.
 */
export function CreateBotDialog({
  open,
  onOpenChange,
  endpoints,
  onManageProviders,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoints: EndpointView[];
  onManageProviders: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<AvatarShapeId>(randomShape);
  const [color, setColor] = useState<AvatarColorId>(randomColor);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [pending, setPending] = useState(false);

  const accent = COLORS.find((entry) => entry.id === color)?.hex ?? "#1884fc";
  const endpoint = endpoints.find((entry) => entry.id === endpointId) ?? null;
  const ready = endpoints.length === 0 || Boolean(endpointId && modelId.trim());

  // Arrive on a working choice: the first provider and its own default model.
  useEffect(() => {
    if (!open) return;
    if (endpointId && endpoints.some((entry) => entry.id === endpointId)) return;
    const first = endpoints[0];
    setEndpointId(first?.id ?? null);
    setModelId(first?.modelId ?? "");
  }, [endpoints, endpointId, open]);

  async function submit() {
    if (!name.trim() || pending || !ready) return;
    setPending(true);
    const result = await createBot({
      name,
      shape,
      color,
      accentColor: accent,
      endpointId,
      modelId,
    });
    setPending(false);
    onOpenChange(false);
    setName("");
    router.push(`/b/${result.botId}`);
    router.refresh();
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent width={438} className="flex flex-col" data-testid="create-bot-dialog">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-4">
          <DialogTitle className="text-lg font-semibold">Create New Bot</DialogTitle>
          <DialogClose
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-pill text-ink-secondary hover:bg-raised"
          >
            ✕
          </DialogClose>
        </div>

        {endpoints.length === 0 ? (
          <div className="flex flex-1 flex-col items-center gap-3 px-6 py-10 text-center" data-testid="create-bot-no-provider">
            <p className="text-body font-medium text-ink">Add a provider first</p>
            <p className="max-w-[320px] text-body text-ink-secondary">
              A bot answers through a model provider. Connect one in Settings, then come back and name
              your bot.
            </p>
            <Button
              variant="primary"
              className="mt-1 h-9 px-4"
              onClick={() => {
                onOpenChange(false);
                onManageProviders();
              }}
            >
              Go to Settings → Providers
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col items-center gap-5 px-6 py-6">
              <Avatar shape={shape} color={color} size={96} title="" />
              <Input
                aria-label="Bot name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name your Bot"
                className="h-10 text-center text-body"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <AvatarPicker shape={shape} color={color} onShape={setShape} onColor={setColor} />

              <div className="w-full space-y-2" data-testid="create-bot-model">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-muted">Provider</span>
                  <Select
                    value={endpointId ?? undefined}
                    onValueChange={(value) => {
                      setEndpointId(value);
                      const next = endpoints.find((entry) => entry.id === value);
                      setModelId(next?.modelId ?? "");
                    }}
                    placeholder="Pick a provider"
                    options={endpoints.map((entry) => ({ value: entry.id, label: entry.label }))}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-muted">Model</span>
                  <span className="text-sm text-ink-faint">{endpoint?.label}</span>
                </div>
                <ModelPicker
                  value={modelId}
                  onChange={setModelId}
                  providerHint={endpoint?.providerHint ?? null}
                  endpointId={endpoint?.id ?? null}
                  placeholder="Pick a model"
                />
              </div>
            </div>

            <div className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-hairline px-4">
              <DialogClose
                className={cn("h-9 rounded-pill px-4 text-base font-medium text-ink hover:bg-raised")}
              >
                Cancel
              </DialogClose>
              <Button
                variant="primary"
                className="h-9 px-4"
                disabled={!name.trim() || pending || !ready}
                onClick={submit}
              >
                {pending ? "Creating…" : "Create"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
