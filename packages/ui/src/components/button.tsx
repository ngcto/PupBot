"use client";

import { Button as BaseButton } from "@base-ui-components/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill text-base font-medium transition-colors duration-[90ms] select-none disabled:pointer-events-none disabled:opacity-40 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        primary: "bg-ink text-canvas hover:bg-white active:bg-[#e8e8e8]",
        secondary: "bg-raised-1 text-ink hover:bg-raised-2 active:bg-raised-3",
        subtle: "bg-raised text-ink hover:bg-raised-2",
        ghost: "text-ink hover:bg-raised active:bg-raised-2",
        outline: "border border-menu text-ink hover:bg-raised",
        danger: "bg-danger-solid text-white hover:brightness-110",
        accent: "text-ink hover:brightness-110 [background:var(--accent,#f5f5f5)]",
      },
      size: {
        sm: "h-8 px-3 text-base",
        md: "h-9 px-4 text-base",
        lg: "h-10 px-5",
        icon: "size-9 p-0 bg-raised text-ink-secondary hover:bg-raised-2 hover:text-ink",
        "icon-sm": "size-8 p-0 rounded-md bg-raised text-ink-secondary hover:bg-raised-2 hover:text-ink",
        disc: "size-9 p-0 rounded-pill bg-raised text-ink-secondary hover:bg-raised-2 hover:text-ink",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<typeof BaseButton> & VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <BaseButton className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
