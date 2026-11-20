"use client";

import { Avatar } from "@pupbot/avatars/react";
import { Button, DialogClose, DialogContent, DialogRoot, DialogTitle, Input, cn } from "@pupbot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setPrimaryBot } from "../app/actions.ts";
import type { BotView } from "../lib/types.ts";

export function PrimaryBotDialog({
  open,
  onOpenChange,
  bots,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: BotView[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const matches = bots.filter((bot) => bot.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent width={439} data-testid="primary-bot-dialog">
        <div className="flex h-12 items-center justify-between border-b border-hairline px-4">
          <DialogTitle className="text-lg font-semibold">Choose a primary Bot</DialogTitle>
          <DialogClose aria-label="Close" className="text-ink-secondary hover:text-ink">
            ✕
          </DialogClose>
        </div>
        <div className="px-4 py-3">
          <Input
            aria-label="Search bots"
            placeholder="Search Bots"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9"
          />
          <div className="mt-2 max-h-[112px] overflow-y-auto scroll-thin">
            {matches.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => setPicked(bot.id)}
                className={cn(
                  "flex h-11 w-full items-center gap-3 rounded-md px-2 text-left",
                  picked === bot.id ? "bg-raised-3" : "hover:bg-raised",
                )}
              >
                <Avatar shape={bot.shape as never} color={bot.color} size={24} title="" />
                <span className="text-body text-ink">{bot.name}</span>
                {bot.isPrimary ? <span className="ml-auto text-sm text-ink-muted">Primary</span> : null}
              </button>
            ))}
            {matches.length === 0 ? <p className="px-2 py-3 text-base text-ink-muted">No bots match.</p> : null}
          </div>
        </div>
        <div className="flex h-14 items-center justify-end gap-2 border-t border-hairline px-4">
          <DialogClose className="h-9 rounded-pill px-4 text-base font-medium text-ink hover:bg-raised">
            Cancel
          </DialogClose>
          <Button
            variant="primary"
            className="h-9 px-4"
            disabled={!picked}
            onClick={async () => {
              if (!picked) return;
              await setPrimaryBot(picked);
              router.push(`/b/${picked}`);
              router.refresh();
              onOpenChange(false);
            }}
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
