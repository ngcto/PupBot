"use client";

import { Popover as BasePopover } from "@base-ui-components/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export const PopoverRoot = BasePopover.Root;

export function Popover({
  trigger,
  children,
  side = "bottom",
  align = "end",
  className,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={8} className="z-50">
          <BasePopover.Popup
            className={cn(
              "rounded-lg border border-menu bg-raised p-3 text-body shadow-popover outline-none",
              "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] transition-[opacity,transform] duration-120",
              className,
            )}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

export type PopoverPopupProps = ComponentProps<typeof BasePopover.Popup>;
