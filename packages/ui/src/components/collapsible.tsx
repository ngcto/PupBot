"use client";

import { Collapsible as BaseCollapsible } from "@base-ui-components/react/collapsible";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export const CollapsibleRoot = BaseCollapsible.Root;
export const CollapsibleTrigger = BaseCollapsible.Trigger;

export function CollapsiblePanel({ className, ...props }: ComponentProps<typeof BaseCollapsible.Panel>) {
  return (
    <BaseCollapsible.Panel
      className={cn("overflow-hidden", className)}
      {...props}
    />
  );
}
