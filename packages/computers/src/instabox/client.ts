import { z } from "zod";
import { ProviderError } from "../contract.ts";
import type { ProviderErrorCode } from "../contract.ts";

/**
 * The Instabox HTTP client: one place that knows the wire format, the
 * idempotency rules and the error codes, so the provider above it only has to
 * think in boxes.
 *
 * Behaviour here is shaped by measurements in the computers spec: a create
 * answers in ~100 ms with an operation and the box is not usable for seconds
 * after; a resume returns before exec works; exec on a suspended box is a hard
 * 409 with no implicit wake; and a fresh box can stall for 30 s on its first
 * commands, so the default exec budget is above 40 s.
 */

export const DEFAULT_BASE_URL = "https://api.instabox.sh";

export interface InstaboxClientOptions {
  apiKey: string;
  /** Pool account key carried on every ComputerRef; the client itself is per account. */
  account: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const errorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().optional(),
  operationId: z.string().nullable().optional(),
});

const operationSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  type: z.string(),
  state: z.string(),
  phase: z.string().optional(),
  error: errorSchema.nullable().optional(),
});

export type InstaboxOperation = z.infer<typeof operationSchema>;

const machineSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string(),
  desiredState: z.string().optional(),
  runtime: z
    .object({
      ready: z.boolean(),
      processesPreserved: z.boolean().optional(),
      hostUnreachable: z.boolean().optional(),
    })
    .optional(),
  spec: z
    .object({
      vcpus: z.number().optional(),
      memMiB: z.number().optional(),
      persistentDiskGiB: z.number().optional(),
    })
    .optional(),
  autoSuspendAfterSeconds: z.number().nullable().optional(),
  maxRunMinutes: z.number().optional(),
  autoSuspendedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  lastError: errorSchema.nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export type InstaboxMachine = z.infer<typeof machineSchema>;

const machineListSchema = z.object({
  machines: z.array(machineSchema),
  nextCursor: z.string().nullable().optional(),
});

const execResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  signal: z.string().optional(),
});

export type InstaboxExecResult = z.infer<typeof execResultSchema>;

const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["dir", "file", "symlink", "other"]),
  size: z.number(),
  mode: z.string(),
  modTime: z.string(),
  target: z.string().optional(),
});

const filesSchema = z.object({
  path: z.string(),
  type: z.enum(["dir", "file", "other"]),
  size: z.number().optional(),
  mode: z.string().optional(),
  modTime: z.string().optional(),
  entries: z.array(fileEntrySchema).optional(),
});

export type InstaboxFiles = z.infer<typeof filesSchema>;

const desktopSchema = z.object({
  installed: z.boolean(),
  installing: z.boolean(),
  running: z.boolean(),
  failed: z.boolean(),
  kind: z.string().optional(),
});

export type InstaboxDesktop = z.infer<typeof desktopSchema>;

const leaseSchema = z.object({
  id: z.string(),
  machineId: z.string().optional(),
  expiresAt: z.string(),
});

const AUTH_CODES = new Set([
  "unauthenticated",
  "missing_key",
  "malformed_key",
  "invalid_key",
  "expired_key",
  "revoked_key",
  "session_expired",
  "missing_scope",
]);

/** Billing and concurrency refusals mean "this account cannot take another box". */
const QUOTA_CODES = new Set([
  "quota_exceeded",
  "concurrency_limit",
  "credit_exhausted",
  "spend_limit_reached",
  "subscription_required",
  "payment_method_required",
  "early_allowance_ended",
  "payment_failed",
]);

const TEMPLATE_CODES = new Set(["template_not_allowed", "template_job_only", "template_limit", "spec_not_allowed"]);

const UNAVAILABLE_CODES = new Set([
  "host_unavailable",
  "kernel_unavailable",
  "template_unavailable",
  "private_ports_unavailable",
  "internal",
  "vault_unavailable",
  "metrics_unavailable",
  "logs_unavailable",
]);

const BAD_REQUEST_CODES = new Set([
  "bad_request",
  "unknown_field",
  "feature_disabled",
  "delete_confirmation_required",
  "not_a_file",
  "missing_parent",
  "too_large",
  "no_space",
  "disk_too_small",
  "grow_needs_stop",
  "resize_restart_off",
  "restore_unavailable",
  "fork_unavailable",
  "max_run_disabled",
  "desktop_not_running",
  "invalid_guest_user",
  "idempotency_conflict",
]);

const CODE_MAP: Record<string, ProviderErrorCode> = {
  not_found: "not_found",
  machine_not_running: "not_running",
  operation_conflict: "busy",
  machine_cooldown: "busy",
  no_capacity: "no_capacity",
  rate_limited: "rate_limited",
};

/** Status codes that only make sense once the body's own code is unknown. */
function codeFromStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "busy";
  if (status === 429) return "quota";
  if (status === 400 || status === 413) return "bad_request";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function classify(code: string, status: number): ProviderErrorCode {
  if (AUTH_CODES.has(code)) return "auth";
  if (QUOTA_CODES.has(code)) return "quota";
  if (TEMPLATE_CODES.has(code)) return "template_refused";
  if (UNAVAILABLE_CODES.has(code)) return "unavailable";
  if (BAD_REQUEST_CODES.has(code)) return "bad_request";
  return CODE_MAP[code] ?? codeFromStatus(status);
}

export interface InstaboxErrorPayload {
  code: string;
  message?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

/** Turn an Instabox error body into the one error type product code branches on. */
export function providerErrorFrom(status: number, payload: InstaboxErrorPayload | undefined): ProviderError {
  if (!payload) {
    const code = codeFromStatus(status);
    return new ProviderError(code, `instabox answered ${status}`, { status });
  }
  const code = classify(payload.code, status);
  const retryable =
    payload.retryable ?? (code === "no_capacity" || code === "rate_limited" || code === "unavailable" || code === "busy");
  return new ProviderError(code, payload.message ?? payload.code, {
    retryable,
    retryAfterSeconds: payload.retryAfterSeconds,
    providerCode: payload.code,
    status,
  });
}

export class InstaboxClient {
  readonly account: string;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: InstaboxClientOptions) {
    this.#apiKey = options.apiKey;
    this.account = options.account;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetch ?? fetch;
  }

  machineUrl(id: string): string {
    return `${this.baseUrl}/v1/machines/${encodeURIComponent(id)}`;
  }

  async createMachine(body: Record<string, unknown>, options: RequestOptions = {}): Promise<InstaboxOperation> {
    return this.#json("POST", "/v1/machines", operationSchema, { body, idempotent: true, ...options });
  }

  async getMachine(id: string, options: RequestOptions = {}): Promise<InstaboxMachine> {
    return this.#json("GET", `/v1/machines/${encodeURIComponent(id)}`, machineSchema, options);
  }

  async listMachines(options: RequestOptions = {}): Promise<Array<InstaboxMachine>> {
    const machines: Array<InstaboxMachine> = [];
    let cursor: string | null | undefined;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.#json("GET", `/v1/machines?${query.toString()}`, machineListSchema, options);
      machines.push(...page.machines);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return machines;
  }

  async startMachine(id: string, body: Record<string, unknown> = {}): Promise<InstaboxOperation> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/start`, operationSchema, {
      body,
      idempotent: true,
    });
  }

  async resumeMachine(id: string): Promise<InstaboxOperation> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/resume`, operationSchema, {
      body: {},
      idempotent: true,
    });
  }

  async suspendMachine(id: string): Promise<InstaboxOperation> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/suspend`, operationSchema, {
      body: {},
      idempotent: true,
    });
  }

  async stopMachine(id: string): Promise<InstaboxOperation> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/stop`, operationSchema, {
      body: {},
      idempotent: true,
    });
  }

  async deleteMachine(id: string): Promise<InstaboxOperation> {
    return this.#json("DELETE", `/v1/machines/${encodeURIComponent(id)}`, operationSchema, {
      idempotent: true,
      headers: { "X-Confirm-Delete": id },
    });
  }

  async getOperation(id: string, options: RequestOptions & { wait?: string } = {}): Promise<InstaboxOperation> {
    const query = options.wait ? `?wait=${encodeURIComponent(options.wait)}` : "";
    return this.#json("GET", `/v1/operations/${encodeURIComponent(id)}${query}`, operationSchema, {
      timeoutMs: 45_000,
      ...options,
    });
  }

  /** Follow an accepted operation until it succeeds, giving up at the deadline. */
  async waitForOperation(operation: InstaboxOperation, options: RequestOptions = {}): Promise<InstaboxOperation> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let current = operation;
    while (current.state === "queued" || current.state === "running") {
      if (Date.now() > deadline) {
        throw new ProviderError("timeout", `${current.type} operation ${current.id} did not finish in ${timeoutMs}ms`, {
          providerCode: "operational_timeout",
        });
      }
      current = await this.getOperation(current.id, { signal: options.signal, wait: "10s" });
    }
    if (current.state === "failed") {
      throw providerErrorFrom(500, current.error ?? { code: "unknown", message: `${current.type} failed` });
    }
    return current;
  }

  async exec(
    id: string,
    body: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<InstaboxExecResult> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/exec`, execResultSchema, {
      body,
      headers: { "X-Instabox-Exec-Keepalive": "1" },
      ...options,
    });
  }

  /** Exec with server-sent output chunks; resolves at exit, like the buffered call. */
  async execStream(
    id: string,
    body: Record<string, unknown>,
    onOutput: (chunk: { stream: "stdout" | "stderr"; text: string }) => void,
    options: RequestOptions = {},
  ): Promise<InstaboxExecResult> {
    const response = await this.#send("POST", `/v1/machines/${encodeURIComponent(id)}/exec`, {
      body,
      headers: { Accept: "text/event-stream" },
      ...options,
    });
    if (!response.ok) throw await this.#errorFrom(response);
    if (!response.body) throw new ProviderError("unknown", "instabox returned an empty exec stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: InstaboxExecResult | undefined;

    const handleEvent = (raw: string) => {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) return;
      let payload: unknown;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }
      if (eventName === "stdout" || eventName === "stderr") {
        const text = (payload as { data?: string }).data ?? "";
        if (text) onOutput({ stream: eventName, text });
      } else if (eventName === "exit") {
        result = execResultSchema.parse(payload);
      } else if (eventName === "error") {
        throw providerErrorFrom(503, errorSchema.parse((payload as { error?: unknown }).error ?? payload));
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          handleEvent(raw);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!result) throw new ProviderError("unknown", "the exec stream ended without an exit event");
    return result;
  }

  async listFiles(id: string, path: string, options: RequestOptions = {}): Promise<InstaboxFiles> {
    const query = new URLSearchParams({ path });
    return this.#json("GET", `/v1/machines/${encodeURIComponent(id)}/files?${query.toString()}`, filesSchema, options);
  }

  async readFile(id: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const query = new URLSearchParams({ path });
    const response = await this.#send("GET", `/v1/machines/${encodeURIComponent(id)}/files/content?${query.toString()}`, {
      ...options,
    });
    if (!response.ok) throw await this.#errorFrom(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(
    id: string,
    path: string,
    data: Uint8Array | string,
    options: RequestOptions = {},
  ): Promise<void> {
    const query = new URLSearchParams({ path, parents: "true" });
    const response = await this.#send("PUT", `/v1/machines/${encodeURIComponent(id)}/files?${query.toString()}`, {
      body: typeof data === "string" ? new TextEncoder().encode(data) : data,
      contentType: "application/octet-stream",
      ...options,
    });
    if (!response.ok) throw await this.#errorFrom(response);
  }

  async desktop(
    id: string,
    body: { action: "status" | "install" | "start"; width?: number; height?: number },
    options: RequestOptions = {},
  ): Promise<InstaboxDesktop> {
    return this.#json("POST", `/v1/machines/${encodeURIComponent(id)}/desktop`, desktopSchema, { body, ...options });
  }

  async putLease(id: string, leaseId: string, ttlSeconds: number, options: RequestOptions = {}): Promise<{ id: string; expiresAt: string }> {
    return this.#json(
      "PUT",
      `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(leaseId)}`,
      leaseSchema,
      { body: { ttlSeconds }, ...options },
    );
  }

  async deleteLease(id: string, leaseId: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.#send(
      "DELETE",
      `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(leaseId)}`,
      { ...options },
    );
    if (response.status === 204 || response.status === 404) return;
    if (!response.ok) throw await this.#errorFrom(response);
  }

  async #json<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.#send(method, path, options);
    if (!response.ok) throw await this.#errorFrom(response);
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError("unknown", `instabox answered an unexpected ${path} body: ${parsed.error.message}`, {
        providerCode: "bad_response",
        status: response.status,
      });
    }
    return parsed.data;
  }

  async #send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "X-API-Key": this.#apiKey,
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    let body: RequestInit["body"] | undefined;
    if (options.body !== undefined) {
      if (options.contentType) {
        headers["content-type"] = options.contentType;
        body = options.body as RequestInit["body"];
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
    }
    if (options.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();

    const timeoutMs = options.timeoutMs ?? 40_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    try {
      return await this.#fetch(`${this.baseUrl}${path}`, { method, headers, body, signal });
    } catch (error) {
      if (options.signal?.aborted) throw new ProviderError("timeout", "the request was aborted", { retryable: false });
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError("timeout", `${method} ${path} timed out after ${timeoutMs}ms`, {
          providerCode: "request_timeout",
        });
      }
      throw new ProviderError("unavailable", `could not reach instabox: ${(error as Error).message}`, {
        providerCode: "network",
      });
    }
  }

  async #errorFrom(response: Response): Promise<ProviderError> {
    const text = await response.text().catch(() => "");
    let payload: InstaboxErrorPayload | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      const candidate = errorSchema.safeParse(parsed.error ?? parsed);
      if (candidate.success) payload = candidate.data;
    } catch {
      payload = undefined;
    }
    return providerErrorFrom(response.status, payload);
  }
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  idempotent?: boolean;
  contentType?: string;
}
