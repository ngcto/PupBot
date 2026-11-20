"use client";

import { COLORS, type AvatarColorId, type AvatarShapeId, SHAPES } from "@pupbot/avatars";
import { Avatar } from "@pupbot/avatars/react";
import { Button, DialogClose, DialogContent, DialogRoot, DialogTitle, Input, cn } from "@pupbot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBot } from "../app/actions.ts";
import { AvatarPicker } from "./avatar-picker.tsx";

function randomShape(): AvatarShapeId {
  return SHAPES[Math.floor(Math.random() * SHAPES.length)]!.id;
}

function randomColor(): AvatarColorId {
  return COLORS[Math.floor(Math.random() * COLORS.length)]!.id;
}

export function CreateBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<AvatarShapeId>(randomShape);
  const [color, setColor] = useState<AvatarColorId>(randomColor);
  const [pending, setPending] = useState(false);

  const accent = COLORS.find((entry) => entry.id === color)?.hex ?? "#1884fc";

  async function submit() {
    if (!name.trim() || pending) return;
    setPending(true);
    const result = await createBot({ name, shape, color, accentColor: accent });
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

        <div className="flex flex-1 flex-col items-center gap-5 px-6 py-6">
          <Avatar shape={shape} color={color} size={96} nose title="" />
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
        </div>

        <div className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-hairline px-4">
          <DialogClose
            className={cn(
              "h-9 rounded-pill px-4 text-base font-medium text-ink hover:bg-raised",
            )}
          >
            Cancel
          </DialogClose>
          <Button variant="primary" className="h-9 px-4" disabled={!name.trim() || pending} onClick={submit}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
