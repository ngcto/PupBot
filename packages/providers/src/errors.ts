import type { ModelEvent } from "./types.ts";

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { code?: string; retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code ?? "provider_error";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export class UnsupportedEndpointError extends ProviderError {
  constructor(kind: string) {
    super(`The ${kind} endpoint kind is not wired yet.`, { code: "unsupported_endpoint" });
    this.name = "UnsupportedEndpointError";
  }
}

export type ModelErrorEvent = Extract<ModelEvent, { type: "error" }>;

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ -]?length/i,
  /maximum context/i,
  /context window/i,
  /prompt is too long/i,
  /input (?:is )?too long/i,
  /too many (?:input )?tokens/i,
  /exceeds? the (?:maximum|model)/i,
];

export function isContextOverflow(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/** Anthropic and a few gateways return a nested `{ error: { type, message } }` body. */
export function errorMessageFromBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string; type?: string; code?: string } | string;
      message?: string;
      detail?: string;
    };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 300);
    const message = parsed.error?.message ?? parsed.message ?? parsed.detail;
    return typeof message === "string" ? message.slice(0, 300) : trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

/** Anthropic style `error.type` values and OpenAI `error.code` values we recognize. */
export function codeFromProviderType(type: string | undefined): string | undefined {
  switch (type) {
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "rate_limit_error":
    // fallthrough
    case "rate_limit_exceeded":
      return "rate_limit";
    case "overloaded_error":
    case "server_overloaded":
      return "overloaded";
    case "invalid_request_error":
    // fallthrough
    case "invalid_request":
      return "invalid_request";
    case "context_length_exceeded":
      return "context_overflow";
    case "not_found_error":
    case "model_not_found":
      return "model_not_found";
    case "content_policy_violation":
      return "content_filter";
    case "authentication_expired":
      return "auth";
    default:
      return undefined;
  }
}

export function retryAfterMsFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset-requests") ?? headers.get("x-ratelimit-reset-tokens");
  if (!reset) return undefined;
  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(reset.trim());
  if (!duration) return undefined;
  const value = Number(duration[1]);
  const unit = duration[2] ?? "s";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * scale);
}

/**
 * Maps an HTTP failure from any wire format onto our error codes. `detail` is
 * the response body; provider type/code fields inside it win over the status
 * only when the status alone is ambiguous (400).
 */
export function errorEventFromHttp(status: number, body: string, headers?: Headers): ModelErrorEvent {
  const message = errorMessageFromBody(body);
  const retryAfterMs = retryAfterMsFromHeaders(headers);
  const detail = message || body.slice(0, 300);

  let type: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; code?: string } };
    type = parsed.error?.code ?? parsed.error?.type;
  } catch {
    type = undefined;
  }

  let code = codeFromProviderType(type);
  if (!code) {
    if (status === 401 || status === 403) code = "auth";
    else if (status === 404) code = "model_not_found";
    else if (status === 408) code = "network_error";
    else if (status === 429) code = "rate_limit";
    else if (status === 529) code = "overloaded";
    else if (isContextOverflow(detail)) code = "context_overflow";
    else if (status >= 500) code = "server_error";
    else if (status >= 400) code = "invalid_request";
    else code = "http_error";
  }
  if (code === "invalid_request" && isContextOverflow(detail)) code = "context_overflow";

  const retryable =
    code === "rate_limit" ||
    code === "overloaded" ||
    code === "server_error" ||
    code === "network_error" ||
    type === "server_error";

  return {
    type: "error",
    code,
    status,
    retryable,
    message: `endpoint answered ${status}${detail ? `: ${detail}` : ""}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** A network failure before any bytes arrived; the request may be retried. */
export function networkErrorEvent(error: unknown): ModelErrorEvent {
  return {
    type: "error",
    code: "network_error",
    retryable: true,
    message: error instanceof Error ? error.message : "the endpoint could not be reached",
  };
}

export function streamErrorEvent(error: unknown): ModelErrorEvent {
  return {
    type: "error",
    code: "stream_interrupted",
    retryable: true,
    message: error instanceof Error ? error.message : "the stream ended unexpectedly",
  };
}

/**
 * A model that stops because of its own limits is not a transport failure, but
 * the caller must not treat the answer as complete.
 */
export function finishReasonError(reason: string): ModelErrorEvent | null {
  switch (reason) {
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return {
        type: "error",
        code: "max_tokens",
        retryable: false,
        message: `the model hit its output limit (${reason}); the answer is truncated`,
      };
    case "content_filter":
    case "refusal":
      return {
        type: "error",
        code: "content_filter",
        retryable: false,
        message: "the model refused or the provider's content filter stopped the answer",
      };
    default:
      return null;
  }
}
