import { z } from "zod";
import { ProviderError } from "../contract.ts";
import type { ProviderErrorCode } from "../contract.ts";

/**
 * The Agent37 Cloud HTTP client.
 *
 * Two planes, one key, and the difference matters:
 *  - `https://api.agent37.com/v1` creates and manages instances (the Sandbox
 *    API). A create answers with the instance object once `status` is `running`.
 *  - `https://sandbox.agent37.app/v1` runs exec, answered by the machine the
 *    instance is on. `api.agent37.com` still serves it, one hop slower.
 *
 * Error envelopes differ per plane: the Sandbox API and the gateway both send
 * `{ error: { code, message } }`, while a rejection made *between* the caller and
 * the gateway — a bad key, an unknown instance, a failed wake — sends a flat
 * `{ error: "code" }`. `classify` reads both.
 *
 * Documented at https://www.agent37.com/docs/agents-api (retrieved 2026-11-21).
 */

export const AGENT37_API_URL = "https://api.agent37.com";
export const AGENT37_SANDBOX_URL = "https://sandbox.agent37.app";
/** The gateway an agent template serves its chat API on, unless it declares one. */
export const AGENT37_DEFAULT_PORT = 3737;

/** Agent37's own instance states, as `GET /v1/instances/{id}` reports them. */
export const AGENT37_STATES = [
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "starting",
  "restarting",
  "updating",
  "sleeping",
  "waking",
  "failed",
  "deleting",
  "deleted",
] as const;

export type Agent37State = (typeof AGENT37_STATES)[number];

/** A lifecycle operation still in flight; a caller waits rather than retries. */
export const AGENT37_TRANSITIONAL: ReadonlySet<string> = new Set([
  "provisioning",
  "stopping",
  "starting",
  "restarting",
  "updating",
  "waking",
  "deleting",
]);

const errorEnvelope = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string(),
      message: z.string().optional(),
      detail: z.string().optional(),
      param: z.string().optional(),
      hint: z.string().optional(),
    }),
  ]),
});

const instanceSchema = z.object({
  id: z.string(),
  status: z.string(),
  status_reason: z
    .object({
      code: z.string(),
      message: z.string().optional(),
      detail: z.string().optional(),
      operation: z.string().optional(),
      at: z.number().optional(),
    })
    .nullable()
    .optional(),
  template: z.string().optional(),
  type: z.string().optional(),
  region: z.string().optional(),
  mount_path: z.string().optional(),
  resources: z
    .object({ cpu: z.number().optional(), memory: z.number().optional(), disk: z.number().optional() })
    .optional(),
  url: z.string().optional(),
  domain_urls: z.array(z.string()).optional(),
  name: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  auto_sleep: z.boolean().optional(),
  idle_timeout_seconds: z.number().optional(),
  network: z.union([z.string(), z.object({ allow: z.array(z.string()) })]).optional(),
  past_due: z.boolean().optional(),
  slept_at: z.number().nullable().optional(),
  created: z.number().optional(),
});

export type Agent37Instance = z.infer<typeof instanceSchema>;

const instanceListSchema = z.object({ data: z.array(instanceSchema) });

const execResultSchema = z.object({
  exit_code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export type Agent37ExecResult = z.infer<typeof execResultSchema>;

/** The documented caps and the fields a create accepts. */
export interface Agent37CreateBody {
  template?: string;
  type?: "default" | "vm" | "performance";
  resources?: { cpu?: number; memory?: number; disk?: number };
  region?: "us" | "eu" | "ap-south";
  name?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  budget?: { monthly_cap_micros?: number; credit_micros?: number };
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  mount_path?: string;
  network?: string | { allow: string[] };
}

export interface Agent37ClientOptions {
  apiKey: string;
  /** Pool account key carried on every ref; capacity is counted per account. */
  account: string;
  apiUrl?: string;
  sandboxUrl?: string;
  fetch?: typeof fetch;
}

export interface Agent37RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bytes for a raw write; JSON callers leave it out. */
  rawBody?: string | Uint8Array;
}

/**
 * Agent37 error codes → the contract's vocabulary. Codes not listed here are
 * the provider's own extensions or the agent's, so they become `unknown` with
 * the raw code preserved for a log line.
 */
const CODE_MAP: Record<string, ProviderErrorCode> = {
  // Sandbox API
  invalid_api_key: "auth",
  ip_not_allowed: "auth",
  forbidden: "auth",
  invalid_request: "bad_request",
  not_found: "not_found",
  insufficient_balance: "quota",
  instance_budget_exhausted: "quota",
  instance_limit_reached: "quota",
  tier_limit: "template_refused",
  template_conflict: "template_refused",
  image_too_large: "template_refused",
  capacity_unavailable: "no_capacity",
  no_capacity: "no_capacity",
  rate_limited: "rate_limited",
  try_again: "busy",
  provisioning_failed: "unavailable",
  image_ingest_failed: "unavailable",
  build_conflict: "busy",
  // Transport, between the caller and the gateway
  instance_suspended: "quota",
  container_unavailable: "not_running",
  container_unreachable: "unavailable",
  upstream_unreachable: "unavailable",
  upstream_timeout: "timeout",
  instance_saturated: "unavailable",
  host_mesh_not_ready: "unavailable",
  wake_timeout: "timeout",
  wake_failed: "unavailable",
  internal_error: "unavailable",
  // Agent API
  validation_error: "bad_request",
  file_not_found: "not_found",
  not_a_directory: "bad_request",
  payload_too_large: "bad_request",
  session_busy: "busy",
};

export function classifyAgent37(code: string): ProviderErrorCode {
  return CODE_MAP[code] ?? "unknown";
}

/** Whether a failure is worth retrying, per the documented remedies. */
function retryableFor(code: ProviderErrorCode): boolean {
  return code === "no_capacity" || code === "rate_limited" || code === "unavailable" || code === "busy";
}

export function providerErrorFrom(
  status: number,
  body: unknown,
  fallbackMessage = "the Agent37 request failed",
): ProviderError {
  const parsed = errorEnvelope.safeParse(body);
  let code = `http_${status}`;
  let message = fallbackMessage;
  let detail: string | undefined;

  if (parsed.success) {
    if (typeof parsed.data.error === "string") {
      // A flat transport error: check `error` before reading `code`, exactly as
      // the docs warn, because the envelope differs on this plane.
      code = parsed.data.error;
    } else {
      code = parsed.data.error.code;
      message = parsed.data.error.message ?? message;
      detail = parsed.data.error.detail;
    }
  }

  const mapped = classifyAgent37(code);
  const retryAfter = status === 429 ? 60 : undefined;
  return new ProviderError(mapped, detail ? `${message} (${detail.slice(-300)})` : message, {
    retryable: retryableFor(mapped),
    providerCode: code,
    status,
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
  });
}

/**
 * One client per account. Everything the provider needs from the wire lives
 * here: paths, the two key headers, the timeout shape and the error mapping.
 */
export class Agent37Client {
  readonly account: string;
  readonly apiUrl: string;
  readonly sandboxUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: Agent37ClientOptions) {
    this.account = options.account;
    this.#apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? AGENT37_API_URL).replace(/\/+$/, "");
    this.sandboxUrl = (options.sandboxUrl ?? AGENT37_SANDBOX_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  // ── Sandbox API ────────────────────────────────────────────────────────────

  async createInstance(body: Agent37CreateBody, options: Agent37RequestOptions = {}): Promise<Agent37Instance> {
    return this.#json("POST", `${this.apiUrl}/v1/instances`, body, instanceSchema, options);
  }

  async getInstance(id: string, options: Agent37RequestOptions = {}): Promise<Agent37Instance> {
    return this.#json("GET", `${this.apiUrl}/v1/instances/${encodeURIComponent(id)}`, undefined, instanceSchema, options);
  }

  async listInstances(options: Agent37RequestOptions = {}): Promise<Agent37Instance[]> {
    const page = await this.#json("GET", `${this.apiUrl}/v1/instances`, undefined, instanceListSchema, options);
    return page.data;
  }

  /** Acknowledge-only lifecycle calls; every one returns `{ id, status }`. */
  async lifecycle(
    id: string,
    action: "stop" | "start" | "sleep" | "restart",
    options: Agent37RequestOptions = {},
  ): Promise<{ id: string; status: string }> {
    return this.#json(
      "POST",
      `${this.apiUrl}/v1/instances/${encodeURIComponent(id)}/${action}`,
      undefined,
      z.object({ id: z.string(), status: z.string() }),
      options,
    );
  }

  async deleteInstance(id: string, options: Agent37RequestOptions = {}): Promise<void> {
    const response = await this.#send("DELETE", `${this.apiUrl}/v1/instances/${encodeURIComponent(id)}`, undefined, options);
    if (response.ok) return;
    // A delete that failed silently would leave the instance billing disk while
    // the caller believed it was gone. Read the envelope so the reason reaches
    // the allocator as a real ProviderError code.
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw providerErrorFrom(response.status, parsed, `Agent37 could not delete ${id}`);
  }

  async editInstance(
    id: string,
    body: { auto_sleep?: boolean; idle_timeout_seconds?: number; metadata?: Record<string, string>; name?: string },
    options: Agent37RequestOptions = {},
  ): Promise<Agent37Instance> {
    return this.#json(
      "PATCH",
      `${this.apiUrl}/v1/instances/${encodeURIComponent(id)}`,
      body,
      instanceSchema,
      options,
    );
  }

  // ── Sandbox API, on the instance's own machine ─────────────────────────────

  /**
   * Run one command. `sh -c` inside the instance, as the image's default user
   * unless `user: "root"`. A sleeping instance is woken first, which is the one
   * place Agent37 will wake a box implicitly — the provider never relies on it,
   * because the contract says `start` is the wake.
   */
  async exec(
    id: string,
    command: string,
    options: Agent37RequestOptions & { user?: "root" } = {},
  ): Promise<Agent37ExecResult> {
    return this.#json(
      "POST",
      `${this.sandboxUrl}/v1/instances/${encodeURIComponent(id)}/exec`,
      { command, ...(options.user ? { user: options.user } : {}) },
      execResultSchema,
      options,
    );
  }

  /**
   * One raw request to the instance URL, used for the agent template's file API,
   * whose writes are the file's exact bytes rather than JSON. The key goes as
   * `X-Agent37-Key`, the same header the instance plane uses.
   */
  async requestRaw(
    method: "GET" | "PUT" | "DELETE" | "PATCH",
    url: string,
    options: Agent37RequestOptions & { body?: string | Uint8Array } = {},
  ): Promise<Response> {
    return this.#send(method, url, undefined, { ...options, rawBody: options.body }, true);
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  async #json<T>(
    method: string,
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    options: Agent37RequestOptions,
  ): Promise<T> {
    const response = await this.#send(method, url, body, options);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ProviderError("unavailable", `Agent37 answered ${response.status} with a non-JSON body`, {
        providerCode: "bad_response",
        status: response.status,
      });
    }
    if (!response.ok) throw providerErrorFrom(response.status, parsed);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ProviderError("unavailable", `Agent37 answered an unexpected shape: ${result.error.message}`, {
        providerCode: "bad_response",
        status: response.status,
      });
    }
    return result.data;
  }

  async #send(
    method: string,
    url: string,
    body: unknown,
    options: Agent37RequestOptions,
    instancePlane = false,
  ): Promise<Response> {
    // exec, the file API and everything else served by the instance's own
    // machine wants `X-Agent37-Key`; every control-plane call at api.agent37.com
    // wants a Bearer token. Both take the same key.
    const onInstance = instancePlane || url.startsWith(this.sandboxUrl);
    const headers: Record<string, string> = onInstance
      ? { "x-agent37-key": this.#apiKey }
      : { authorization: `Bearer ${this.#apiKey}` };
    const raw = options.rawBody;
    if (raw !== undefined) {
      // A raw write carries the file's own bytes; the docs do not require a
      // content type, and octet-stream is the honest one for an arbitrary file.
      headers["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      return await this.#fetch(url, {
        method,
        headers,
        body: raw !== undefined ? (typeof raw === "string" ? raw : new Blob([raw as Uint8Array<ArrayBuffer>])) : body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error && reason.message === "timeout") {
          throw new ProviderError("timeout", `Agent37 did not answer ${method} ${url} within ${timeoutMs} ms`, {
            providerCode: "request_timeout",
          });
        }
        throw new ProviderError("unavailable", "the Agent37 request was aborted", { providerCode: "aborted" });
      }
      throw new ProviderError("unavailable", error instanceof Error ? error.message : String(error), {
        providerCode: "network",
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
