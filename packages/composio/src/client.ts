import { ComposioError, errorCodeForStatus } from "./errors.ts";
import {
  authConfigListSchema,
  authConfigFromWire,
  createdAuthConfigSchema,
  connectionFromWire,
  connectionListSchema,
  linkFromWire,
  linkSchema,
  messageFromErrorBody,
  toolkitFromWire,
  toolkitListSchema,
} from "./wire.ts";
import type { AuthConfig, Connection, ConnectionLink, ToolkitPage, ToolkitSummary } from "./types.ts";
import { supportFor } from "./types.ts";

/**
 * Composio Platform REST v3.1 (docs.composio.dev/reference). The base URL ends
 * at the API version so a test can point the whole client at a local server and
 * exercise the same code path the live project runs.
 */
export const DEFAULT_API_BASE_URL = "https://backend.composio.dev/api/v3.1";

export interface ComposioClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request budget. Listing toolkits is fast; a hung socket should not hang a page. */
  timeoutMs?: number;
}

export interface ListToolkitsInput {
  search?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  sortBy?: "usage" | "alphabetically";
}

export interface ListConnectionsInput {
  userIds: string[];
  toolkitSlugs?: string[];
  limit?: number;
}

export interface EnsureAuthConfigInput {
  toolkit: string;
  /** The toolkit's advertised schemes, so the client never invents one. */
  authSchemes: string[];
  managedAuthSchemes: string[];
  /** Shown in the Composio dashboard when a config is created. */
  name?: string;
}

const USER_SUPPLIED_ORDER = ["OAUTH2", "API_KEY", "BEARER_TOKEN", "BASIC", "OAUTH1"];

export class ComposioClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ComposioClientOptions) {
    if (!options.apiKey) throw new ComposioError("not_configured", "Composio is not configured: no project API key.");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /* ───────────────────────────── apps ───────────────────────────── */

  async listToolkits(input: ListToolkitsInput = {}): Promise<ToolkitPage> {
    const body = await this.#request("GET", "/toolkits", {
      query: {
        search: input.search,
        category: input.category,
        cursor: input.cursor,
        sort_by: input.sortBy ?? "usage",
        limit: input.limit ?? 60,
        // Deprecated rows are still served by the catalog; a marketplace should not show them.
        include_deprecated: "false",
      },
    });
    const parsed = toolkitListSchema.safeParse(body);
    if (!parsed.success) throw schemaError("toolkits", parsed.error);
    return {
      items: parsed.data.items.map(toolkitFromWire),
      nextCursor: parsed.data.next_cursor ?? null,
    };
  }

  async getToolkit(slug: string): Promise<ToolkitSummary | null> {
    try {
      const body = await this.#request("GET", `/toolkits/${encodeURIComponent(slug)}`);
      const parsed = toolkitListSchema.shape.items.element.safeParse(body);
      if (!parsed.success) throw schemaError("toolkit", parsed.error);
      return toolkitFromWire(parsed.data);
    } catch (error) {
      if (error instanceof ComposioError && error.code === "not_found") return null;
      throw error;
    }
  }

  /* ────────────────────────── auth configs ──────────────────────── */

  async listAuthConfigs(toolkitSlug?: string): Promise<AuthConfig[]> {
    const configs: AuthConfig[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body = await this.#request("GET", "/auth_configs", {
        query: { toolkit_slug: toolkitSlug, limit: 200, cursor },
      });
      const parsed = authConfigListSchema.safeParse(body);
      if (!parsed.success) throw schemaError("auth configs", parsed.error);
      configs.push(...parsed.data.items.map(authConfigFromWire));
      cursor = parsed.data.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return configs;
  }

  /**
   * The auth config a connect flow runs against. Returns the project's existing
   * config for the toolkit when there is one, so a config Ng creates in the
   * Composio dashboard is picked up rather than duplicated.
   */
  async findAuthConfig(toolkit: string): Promise<AuthConfig | null> {
    const configs = await this.listAuthConfigs(toolkit);
    return configs.find((config) => config.toolkit === toolkit) ?? null;
  }

  /**
   * Reuse or create the project's auth config for a toolkit.
   *
   * Two documented paths, in this order:
   * - `use_composio_managed_auth` when the toolkit advertises a managed scheme
   *   (docs.composio.dev/docs/authentication/programmatic-auth-configs —
   *   "Composio maintains a managed app so you can create an auth config
   *   without bringing your own credentials").
   * - `use_custom_auth` with empty `credentials` for a key-based toolkit, which
   *   the docs describe as the case "where the user supplies the key at connect
   *   time". The hosted Connect Link then collects it, so the key never reaches
   *   our server or database.
   *
   * A toolkit that is neither gets `not_configured`: it needs an OAuth client
   * registered for it (or provider review) before it can connect at all.
   */
  async ensureAuthConfig(input: EnsureAuthConfigInput): Promise<AuthConfig> {
    const existing = await this.findAuthConfig(input.toolkit);
    if (existing) return existing;

    const name = input.name ?? input.toolkit;
    const support = supportFor(input);

    if (support === "managed") {
      const managedScheme = input.managedAuthSchemes.find((scheme) => scheme === "OAUTH2" || scheme === "OAUTH1");
      const body = await this.#request("POST", "/auth_configs", {
        body: {
          toolkit: { slug: input.toolkit },
          auth_config: { type: "use_composio_managed_auth", name, authScheme: managedScheme },
        },
      });
      return this.#createdAuthConfig(body);
    }

    if (support === "user-key") {
      const scheme = USER_SUPPLIED_ORDER.find((candidate) => input.authSchemes.includes(candidate));
      const body = await this.#request("POST", "/auth_configs", {
        body: {
          toolkit: { slug: input.toolkit },
          auth_config: { type: "use_custom_auth", authScheme: scheme, name, credentials: {} },
        },
      });
      return this.#createdAuthConfig(body);
    }

    throw new ComposioError(
      "not_configured",
      `${input.toolkit} cannot be connected with Composio's own credentials yet: it signs in with ${describeSchemes(input.authSchemes)} and needs an OAuth client registered for it before users can connect.`,
    );
  }

  #createdAuthConfig(body: unknown): AuthConfig {
    const parsed = createdAuthConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new ComposioError("upstream", "Composio created an auth config but returned an unexpected shape.");
    }
    const managed = parsed.data.auth_config.is_composio_managed ?? false;
    return {
      id: parsed.data.auth_config.id,
      toolkit: parsed.data.toolkit?.slug ?? "",
      scheme: parsed.data.auth_config.auth_scheme ?? "",
      managed,
      userSupplied: !managed,
    };
  }

  /* ─────────────────────── connected accounts ───────────────────── */

  /**
   * Starts the hosted connect flow and creates the connected account against it
   * (POST /connected_accounts/link). The account starts in INITIALIZING and is
   * only ACTIVE once the user finishes on Composio's page.
   */
  async startLink(input: {
    authConfigId: string;
    userId: string;
    alias?: string;
    callbackUrl?: string;
  }): Promise<ConnectionLink> {
    const body = await this.#request("POST", "/connected_accounts/link", {
      body: {
        auth_config_id: input.authConfigId,
        user_id: input.userId,
        ...(input.alias ? { alias: input.alias } : {}),
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      },
    });
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw schemaError("connect link", parsed.error);
    return linkFromWire(parsed.data);
  }

  async getConnection(id: string): Promise<Connection | null> {
    try {
      const body = await this.#request("GET", `/connected_accounts/${encodeURIComponent(id)}`);
      return this.#connection(body);
    } catch (error) {
      if (error instanceof ComposioError && error.code === "not_found") return null;
      throw error;
    }
  }

  async listConnections(input: ListConnectionsInput): Promise<Connection[]> {
    if (input.userIds.length === 0) return [];
    const body = await this.#request("GET", "/connected_accounts", {
      query: {
        user_ids: input.userIds.join(","),
        toolkit_slugs: input.toolkitSlugs?.join(","),
        limit: input.limit ?? 100,
        order_by: "created_at",
        order_direction: "desc",
      },
    });
    const parsed = connectionListSchema.safeParse(body);
    if (!parsed.success) throw schemaError("connected accounts", parsed.error);
    return parsed.data.items.map(connectionFromWire);
  }

  /** Deletes on Composio's side and revokes the grant at the provider. */
  async deleteConnection(id: string): Promise<void> {
    await this.#request("DELETE", `/connected_accounts/${encodeURIComponent(id)}`, {
      query: { revoke_on_delete: "true" },
    });
  }

  #connection(body: unknown): Connection {
    const parsed = connectionListSchema.shape.items.element.safeParse(body);
    if (!parsed.success) throw schemaError("connected account", parsed.error);
    return connectionFromWire(parsed.data);
  }

  /* ───────────────────────────── transport ──────────────────────── */

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          "x-api-key": this.#apiKey,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ComposioError(
        timedOut ? "timeout" : "network",
        timedOut ? "Composio did not answer in time." : "Could not reach Composio.",
      );
    }

    const text = await response.text();
    const body = text ? safeJson(text) : null;

    if (!response.ok) {
      const { message, detail } = messageFromErrorBody(body, `Composio answered ${response.status}.`);
      throw new ComposioError(errorCodeForStatus(response.status), message, { status: response.status, detail });
    }
    return body;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function schemaError(what: string, error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  const first = error.issues[0];
  const at = first?.path.map(String).join(".") || "(root)";
  return new ComposioError("upstream", `Composio returned an unexpected shape for ${what} at ${at}.`);
}

function describeSchemes(schemes: string[]): string {
  if (schemes.length === 0) return "credentials Composio cannot supply";
  return schemes.join(", ").toLowerCase();
}
