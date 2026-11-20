"use client";

import { Tooltip as BaseTooltip } from "@base-ui-components/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export function Tooltip({
  children,
  content,
  side = "top",
  className,
}: {
  children: ReactElement<Record<string, unknown>>;
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <BaseTooltip.Provider delay={260}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={8} className="z-50">
            <BaseTooltip.Popup
              className={cn(
                "rounded-sm bg-raised-3 px-2.5 py-1.5 text-sm text-ink shadow-popover",
                "data-[starting-style]:opacity-0 transition-opacity duration-100",
                className,
              )}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
