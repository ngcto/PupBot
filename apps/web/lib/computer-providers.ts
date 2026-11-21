/**
 * The computer providers a workspace may configure itself.
 *
 * A plain module, not `actions.ts`: a `"use server"` file may only export async
 * functions, and this list is a value the client renders a picker from. It is also
 * imported by the server action, so the picker and the guard cannot disagree about
 * what is allowed.
 *
 * Boat is deliberately absent. Its contract exists and `packages/computers` maps
 * it, but `createProviderFactory` throws "not implemented" for it — so accepting a
 * Boat key would show a connected account that fails every request. It comes back
 * to this list the moment the provider is real, and not before.
 */
export const CONFIGURABLE_COMPUTER_PROVIDERS = ["instabox"] as const;

export type ConfigurableComputerProvider = (typeof CONFIGURABLE_COMPUTER_PROVIDERS)[number];

export function providerName(provider: string): string {
  if (provider === "instabox") return "Instabox";
  if (provider === "boat") return "Boat";
  if (provider === "fake") return "Local test pool";
  if (provider === "agent37") return "Agent37";
  return provider;
}

export function providerHelper(provider: string): string {
  if (provider === "instabox") return "Pauses and resumes with your processes intact.";
  if (provider === "boat") return "Cheaper per hour; a stop loses what was in memory.";
  return "Provided by this deployment.";
}
