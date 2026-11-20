"use client";

import { Switch as BaseSwitch } from "@base-ui-components/react/switch";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center rounded-pill outline-none transition-colors duration-150",
        "bg-[#3b3b3b] data-[checked]:bg-[#2f7cf6]",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block size-4 translate-x-0.5 rounded-pill bg-white transition-transform duration-150 data-[checked]:translate-x-[18px]" />
    </BaseSwitch.Root>
  );
}
