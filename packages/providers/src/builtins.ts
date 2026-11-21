import type { EndpointKind } from "./types.ts";

/**
 * Providers whose base URL is fixed and known: the user picks one, pastes a key,
 * and it works. The table is the only place these URLs live — not the database,
 * not the browser — so a wrong value is fixed in one review and no user's saved
 * row can drift from what the provider actually serves.
 *
 * Every URL here was read from the provider's own documentation on 2026-11-21
 * and then probed live from this repo's guard (`GET {baseUrl}/models` and a
 * `chat/completions` call that answers with the provider's own auth error). The
 * `docsUrl` beside each row is what to re-read when a provider moves.
 */
export interface BuiltinProvider {
  /** Stable id, also stored on the endpoint row. Changing one orphans saved rows. */
  id: string;
  /** What Settings and the bot dialog call it. */
  name: string;
  /** Includes the version segment; our adapters append `chat/completions`. */
  baseUrl: string;
  kind: EndpointKind;
  /** Where to paste a key from. */
  keyUrl: string;
  /** Placeholder under the key field. */
  keyHint: string;
  /** The page that documents this base URL. */
  docsUrl: string;
  /**
   * Headers this provider's documentation makes necessary for a chat request.
   * OpenRouter's ranking headers are documented as optional and are deliberately
   * absent: a provider that does not need a header does not get one, because
   * every header we echo is data about the user we hand over for free.
   */
  headers?: readonly BuiltinHeader[];
}

/**
 * A header that carries a per-request value the caller supplies. OpenCode Go
 * answers `400 MissingSessionID` to a chat request without `x-opencode-session`,
 * so a stable per-conversation value is required, not cosmetic.
 */
export type BuiltinHeader = "session" | "userAgent";

const OPENCODE_GO_HEADERS: readonly BuiltinHeader[] = ["session", "userAgent"];

export const BUILTIN_PROVIDERS: readonly BuiltinProvider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "openai-chat",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "Paste your OpenRouter key (starts with sk-or-)",
    docsUrl: "https://openrouter.ai/docs/quickstart",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    kind: "openai-chat",
    keyUrl: "https://opencode.ai/console/go",
    keyHint: "Paste your OpenCode Console key (starts with oc_sk_)",
    docsUrl: "https://opencode.ai/docs/console/harnesses/",
    headers: OPENCODE_GO_HEADERS,
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    kind: "openai-chat",
    keyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys",
    keyHint: "Paste your AI Gateway key",
    docsUrl: "https://vercel.com/docs/ai-gateway/openai-compat",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    kind: "openai-chat",
    keyUrl: "https://ollama.com/settings/keys",
    keyHint: "Paste your Ollama API key",
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
  },
];

const BY_ID = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]));

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

const BY_BASE_URL = new Map(BUILTIN_PROVIDERS.map((provider) => [normalise(provider.baseUrl), provider]));

/** A built-in by its stored id, or undefined for a custom endpoint or a retired id. */
export function builtinProvider(id: string | null | undefined): BuiltinProvider | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/**
 * The built-in a base URL belongs to. Used for rows saved before the id was
 * stored, so an existing OpenRouter endpoint starts behaving like one.
 */
export function builtinForBaseUrl(baseUrl: string): BuiltinProvider | undefined {
  return BY_BASE_URL.get(normalise(baseUrl));
}

/** True when a stored row is a built-in: its base URL is not the user's to see. */
export function isBuiltinId(id: string | null | undefined): boolean {
  return Boolean(builtinProvider(id));
}

export interface BuiltinRequestContext {
  /** Stable per conversation, so the provider can route and cache one thread together. */
  session?: string;
  userAgent?: string;
}

/**
 * The headers a built-in's documentation makes necessary. `headers` on a saved
 * endpoint is the user's own override and wins, so this is merged first.
 */
export function builtinRequestHeaders(
  provider: BuiltinProvider | undefined,
  context: BuiltinRequestContext = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of provider?.headers ?? []) {
    if (header === "session" && context.session) headers["x-opencode-session"] = context.session;
    if (header === "userAgent" && context.userAgent) headers["user-agent"] = context.userAgent;
  }
  return headers;
}

/**
 * A built-in is useless until it holds a key, and a bot created against it would
 * fail on the first message. Every other keyless endpoint stays usable: the dev
 * stub has no key by design and the AI Gateway is authenticated by deployment
 * credentials, so the rule is about built-ins rather than about keys alone.
 */
export function builtinNeedsKey(endpoint: {
  builtinId: string | null | undefined;
  hasKey: boolean;
}): boolean {
  return isBuiltinId(endpoint.builtinId) && !endpoint.hasKey;
}

/**
 * Whether a bot can be created against this endpoint. A built-in with no key
 * cannot answer, so it is not offered; but a built-in the deployment itself
 * authenticates is usable keyless, and hiding it would disable a provider that
 * works. `deploymentAuthenticated` is where a caller says which of its rows the
 * deployment's own credentials cover.
 */
export function endpointUsableForBot(endpoint: {
  builtinId: string | null | undefined;
  hasKey: boolean;
  deploymentAuthenticated?: boolean;
}): boolean {
  if (endpoint.hasKey) return true;
  if (endpoint.deploymentAuthenticated) return true;
  return !isBuiltinId(endpoint.builtinId);
}
