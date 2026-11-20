"use client";

import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export const TabsRoot = BaseTabs.Root;
export const TabsPanel = ({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) => (
  <BaseTabs.Panel className={cn("outline-none", className)} {...props} />
);

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return <BaseTabs.List className={cn("flex items-center gap-1", className)} {...props} />;
}

export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      data-slot="tab"
      className={cn(
        "flex h-[26px] items-center rounded-pill px-3 text-base font-medium text-ink-muted outline-none transition-colors duration-150",
        "hover:text-ink-secondary data-[selected]:bg-raised data-[selected]:text-ink",
        className,
      )}
      {...props}
    />
  );
}
