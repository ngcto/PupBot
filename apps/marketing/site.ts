import { marketingEnv } from "./env.ts";

export const site = {
  name: "Terabot",
  wordmark: "terabot",
  tagline: "Bots that each get their own computer.",
  description:
    "Terabot is a chat app for bots you set up yourself. Each bot has a name, a standing brief, the model you point it at, and a cloud computer of its own.",
  url: marketingEnv.NEXT_PUBLIC_SITE_URL,
  appUrl: marketingEnv.NEXT_PUBLIC_APP_URL,
} as const;

export interface NavLink {
  readonly href: string;
  readonly label: string;
}

export const navLinks: readonly NavLink[] = [
  { href: "/", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/docs", label: "Docs" },
];

/** Sign-in happens in the product, so this points across to it. */
export function signInUrl(): string {
  return new URL("/sign-in", site.appUrl).toString();
}

export function signUpUrl(): string {
  return new URL("/sign-up", site.appUrl).toString();
}

export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
