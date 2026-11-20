"use client";

import { Select as BaseSelect } from "@base-ui-components/react/select";
import type { ComponentProps, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "../lib/utils.ts";

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select",
  className,
  disabled,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const items = options.map((option) => ({ value: option.value, label: option.label }));
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => onValueChange?.(String(next))}
      items={items}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-sm px-1 text-body text-ink-secondary outline-none hover:text-ink disabled:opacity-40",
          className,
        )}
      >
        <BaseSelect.Value>
          {(selected: unknown) =>
            options.find((option) => option.value === selected)?.label ?? placeholder
          }
        </BaseSelect.Value>
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className="min-w-[180px] rounded-lg border border-menu bg-raised p-1.5 shadow-menu">
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                data-slot="select-item"
                className="flex h-8 cursor-default items-center justify-between gap-3 rounded-sm px-2.5 text-body text-ink outline-none data-[highlighted]:bg-raised-3"
              >
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <HugeiconsIcon icon={Tick02Icon} size={14} />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
