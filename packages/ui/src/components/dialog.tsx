"use client";

import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
export const DialogTitle = BaseDialog.Title;
export const DialogDescription = BaseDialog.Description;

export function DialogContent({
  className,
  children,
  width = 439,
  ...props
}: ComponentProps<typeof BaseDialog.Popup> & { width?: number }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-40 backdrop-blur-0 transition-opacity duration-[160ms] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
      />
      <BaseDialog.Popup
        data-slot="dialog-popup"
        style={{ width }}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(100vh-48px)] overflow-y-auto scroll-thin rounded-dialog border border-dialog-edge bg-dialog shadow-dialog",
          "data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
          "transition-[opacity,transform] duration-[180ms] ease-standard",
          className,
        )}
        {...props}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex h-12 shrink-0 items-center justify-between border-b border-hairline px-4", className)}>
      {children}
    </div>
  );
}

export function DialogFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex h-16 shrink-0 items-center justify-end gap-2 border-t border-hairline px-4", className)}>
      {children}
    </div>
  );
}
