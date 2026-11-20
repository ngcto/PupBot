import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-input bg-transparent px-3 text-body text-ink placeholder:text-ink-faint outline-none",
        "focus-visible:border-strong",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-body leading-[22px] text-ink placeholder:text-ink-faint outline-none focus-visible:border-strong",
        className,
      )}
      {...props}
    />
  );
}
