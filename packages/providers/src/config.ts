import { builtinProvider, builtinRequestHeaders } from "./builtins.ts";
import type { EndpointKind, ModelEndpointConfig } from "./types.ts";

/**
 * What every call site needs from a saved endpoint row. A built-in's `kind` and
 * `baseUrl` come from the table, not the row: the provider's wire format is a
 * fact about the provider, and a row that disagrees with it (an old save, a
 * hand-edited URL) would otherwise send requests to the wrong place.
 */
export interface EndpointRowConfig {
  kind: EndpointKind;
  baseUrl: string;
  builtinId?: string | null;
  model: string;
  apiKey?: string;
  /**
   * The conversation this request belongs to. Providers that route per session
   * need a value that is stable within one thread and different across threads,
   * so pooling every user into one constant would defeat the point of the header.
   */
  session?: string;
  userAgent?: string;
  /** A user's own header overrides, merged last so they can replace a default. */
  headers?: Record<string, string>;
}

/**
 * Sent to providers that ask a client to identify itself rather than present a
 * generic SDK name. A literal because it names this product, not a version.
 */
export const TERABOT_USER_AGENT = "terabot/1.0";

/**
 * The session a non-chat call (a model listing, a connection test) sends. It is
 * not a conversation, so it gets its own fixed value rather than borrowing one.
 */
export const PROBE_SESSION = "terabot-probe";

/**
 * The one place a stored endpoint becomes a request config. Built-in resolution
 * lives here so a moved provider URL is a table edit, and so no call site can
 * build a built-in request that skips the headers its docs require.
 */
export function endpointConfigForRow(row: EndpointRowConfig): ModelEndpointConfig {
  const builtin = builtinProvider(row.builtinId);
  const headers: Record<string, string> = {
    ...builtinRequestHeaders(builtin, {
      ...(row.session ? { session: row.session } : {}),
      userAgent: row.userAgent ?? TERABOT_USER_AGENT,
    }),
    ...row.headers,
  };

  return {
    kind: builtin?.kind ?? row.kind,
    baseUrl: builtin?.baseUrl ?? row.baseUrl,
    model: row.model,
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
