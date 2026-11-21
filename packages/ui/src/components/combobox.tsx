"use client";

import { Combobox as BaseCombobox } from "@base-ui-components/react/combobox";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "../lib/utils.ts";

export interface ComboboxItem {
  value: string;
  label: string;
  /** Second line shown under the label, e.g. context window and price. */
  description?: string;
}

/**
 * Searchable select on Base UI's Combobox. The input stays editable so a value
 * outside the list (an unmatched model id) can still be typed and used.
 */
export function Combobox({
  items,
  value,
  inputValue,
  onInputValueChange,
  onValueChange,
  placeholder,
  emptyMessage = "No matches",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  items: ComboboxItem[];
  value?: string;
  inputValue?: string;
  /** `reason` is Base UI's cause: "none" means the component synced itself. */
  onInputValueChange?: (value: string, reason: string) => void;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  // Base UI matches the controlled value against the `items` collection, so
  // both have to be the same object shape. A typed id outside the catalogue is
  // wrapped into a synthetic item so it still round-trips.
  const selectedItem: ComboboxItem | null = value
    ? (items.find((item) => item.value === value) ?? { value, label: value })
    : null;

  return (
    <BaseCombobox.Root
      items={items}
      value={selectedItem}
      inputValue={inputValue}
      onInputValueChange={(next, eventDetails) =>
        onInputValueChange?.(String(next ?? ""), eventDetails?.reason ?? "none")
      }
      onValueChange={(next) => {
        const picked = (next ?? null) as unknown as ComboboxItem | null;
        onValueChange?.(picked?.value ?? "");
      }}
      itemToStringLabel={(item) => (item as unknown as ComboboxItem).label}
      itemToStringValue={(item) => (item as unknown as ComboboxItem).value}
      isItemEqualToValue={(item, selected) =>
        (item as unknown as ComboboxItem)?.value === (selected as unknown as ComboboxItem)?.value
      }
      filter={(item, query) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        const candidate = item as unknown as ComboboxItem;
        return (
          candidate.label.toLowerCase().includes(needle) ||
          candidate.value.toLowerCase().includes(needle)
        );
      }}
      disabled={disabled}
    >
      <div className={cn("relative", className)}>
        <BaseCombobox.Input
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="h-10 w-full rounded-md border border-input bg-transparent px-3 pr-9 text-body text-ink placeholder:text-ink-faint outline-none focus-visible:border-strong"
        />
        <BaseCombobox.Trigger
          aria-label="Browse models"
          className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
        </BaseCombobox.Trigger>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={6} align="start" className="z-50 w-[var(--anchor-width)]">
          <BaseCombobox.Popup className="max-h-[320px] overflow-y-auto scroll-thin rounded-lg border border-menu bg-raised p-1.5 shadow-menu">
            <BaseCombobox.Empty className="px-2.5 py-2 text-sm text-ink-muted">{emptyMessage}</BaseCombobox.Empty>
            <BaseCombobox.List>
              {(item: unknown) => {
                const option = item as ComboboxItem;
                return (
                <BaseCombobox.Item
                  key={option.value}
                  value={option}
                  className="flex cursor-default items-start justify-between gap-3 rounded-sm px-2.5 py-2 text-body text-ink outline-none data-[highlighted]:bg-raised-3"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.description ? (
                      <span className="text-sm text-ink-muted">{option.description}</span>
                    ) : null}
                  </span>
                  <BaseCombobox.ItemIndicator>
                    <HugeiconsIcon icon={Tick02Icon} size={14} />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
                );
              }}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
