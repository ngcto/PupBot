"use client";

import { ContextMenu } from "@base-ui-components/react/context-menu";
import { Menu } from "@base-ui-components/react/menu";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

const popupClass =
  "z-50 min-w-[207px] rounded-lg border border-menu bg-raised p-[6px] shadow-menu text-body text-ink outline-none";

export const MenuRoot = Menu.Root;
export const MenuItem = ({ className, ...props }: ComponentProps<typeof Menu.Item>) => (
  <Menu.Item
    data-slot="menu-item"
    className={cn(
      "flex h-[34px] cursor-default items-center gap-2 rounded-sm px-3 text-body text-ink outline-none",
      "data-[highlighted]:bg-raised-3",
      className,
    )}
    {...props}
  />
);
export const MenuSeparator = ({ className, ...props }: ComponentProps<typeof Menu.Separator>) => (
  <Menu.Separator className={cn("mx-2 my-1 h-px bg-menu", className)} {...props} />
);

export function MenuPopup({ className, children, align = "start", side = "bottom" }: {
  className?: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={6} align={align} side={side} className="z-50">
        <Menu.Popup className={cn(popupClass, className)}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

type TriggerElement = ReactElement<Record<string, unknown>>;

export function MenuTrigger({ children, ...props }: { children: TriggerElement } & Omit<ComponentProps<typeof Menu.Trigger>, "render">) {
  return <Menu.Trigger render={children} {...props} />;
}

export function ContextMenuArea({ children, items }: { children: TriggerElement; items: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={popupClass}>{items}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export const ContextMenuItem = MenuItem;
export const ContextMenuSeparator = MenuSeparator;
