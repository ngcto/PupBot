import { ProviderError } from "../contract.ts";
import type {
  ActivityLease,
  ComputerProvider,
  ComputerRef,
  ComputerState,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
  ProviderCapabilities,
  ProvisionOptions,
  Screenshot,
} from "../contract.ts";
import { Agent37Client, AGENT37_TRANSITIONAL, providerErrorFrom } from "./client.ts";
import type { Agent37CreateBody, Agent37ExecResult, Agent37Instance } from "./client.ts";

export interface Agent37ProviderOptions {
  /** Pool account key, e.g. "agent37:acct-1". Capacity is counted per account. */
  account: string;
  apiKey: string;
  apiUrl?: string;
  sandboxUrl?: string;
  fetch?: typeof fetch;
  /**
   * Template every instance starts from. Defaults to `agent37-hermes`, which
   * ships a browser and the agent's file API; `agent37-base` is a plain sandbox
   * with no file endpoints, so exec is the only way to move bytes into it.
   */
  template?: string;
  /** Shape. Agent37's documented default is 2 vCPU / 4 GB. */
  resources?: { cpu?: number; memory?: number; disk?: number };
  region?: "us" | "eu" | "ap-south";
  /**
   * Auto-sleep, which is the only idle release Agent37 offers. Off by default so
   * the allocator's own idle sweep stays the single authority over when a box
   * sleeps, exactly as it is for Instabox.
   */
  autoSleep?: boolean;
  /**
   * Opt a box into auto-sleep purely as a leak backstop, even when `autoSleep`
   * is off. Agent37 has no delete-after equivalent, so without this a box whose
   * allocator crashed runs and bills until a human notices.
   */
  leakBackstop?: boolean;
  idleTimeoutSeconds?: number;
  provisionTimeoutMs?: number;
  startTimeoutMs?: number;
}

const DEFAULT_TEMPLATE = "agent37-hermes";
const DEFAULT_PROVISION_TIMEOUT_MS = 300_000;
const DEFAULT_START_TIMEOUT_MS = 300_000;
/**
 * Agent37 has no delete-after field, unlike Instabox's `deleteAfterSeconds`, so a
 * box leaked by a crashed allocator has nothing else to stop it. One day is the
 * provider's own maximum idle window: an orphan stops billing compute by itself
 * and reconcile destroys it on the next pass.
 */
const LEAK_BACKSTOP_IDLE_SECONDS = 86_400;

/**
 * Which contract methods this provider cannot satisfy.
 *
 * The contract allows a partial provider, but a partial provider has to say so:
 * a silent no-op is indistinguishable from success, so each of these throws an
 * `unsupported` ProviderError instead of pretending.
 *
 * As of 2026-11-21, against Agent37's documented API:
 *  - `screenshot` — no screenshot endpoint. `agent37-hermes` has a headless
 *    browser, not a framebuffer, and the only screen Agent37 serves is a noVNC
 *    desktop on a *custom* template built from `hermes-vnc-desktop`, reached by a
 *    signed URL for port 6901. That is a browser session, not a PNG.
 *  - `lease` / `releaseLease` — no activity-lease concept with its own expiry.
 *    Agent37 resets its idle timer on any exec or URL traffic, so this provider
 *    keeps a box awake by touching it and reports the provider's own idle window
 *    as the expiry. That is the closest honest mapping, not a lease.
 */
export const AGENT37_UNSUPPORTED = ["screenshot"] as const;

export type Agent37Unsupported = (typeof AGENT37_UNSUPPORTED)[number];

function unsupported(method: Agent37Unsupported | string, detail: string): ProviderError {
  return new ProviderError("unknown", `${method} is not supported by Agent37: ${detail}`, {
    providerCode: "unsupported",
  });
}

/**
 * The Agent37 implementation of the provider contract.
 *
 * What it satisfies, all from the documented API: `provision`, `start`,
 * `sleep`, `destroy`, `status`, `exec`, `lease`, `releaseLease`,
 * `putFile`, `getFile`, `list` and `listComputers`. Its lifecycle is the closest
 * of the providers to the contract's own model — a sleeping instance keeps
 * memory and running processes and wakes on request, which is the same promise
 * Instabox makes.
 */
export class Agent37Provider implements ComputerProvider {
  readonly name = "agent37";
  readonly account: string;
  readonly client: Agent37Client;

  /**
   * Screenshot is the gap worth reading before building on this provider: there
   * is no framebuffer endpoint, so anything driving a real desktop (Cua Driver,
   * computer-use) has no PNG to steer by. Files are marked partial because they
   * exist only on agent templates.
   */
  readonly capabilities: ProviderCapabilities = {
    exec: true,
    files: true,
    screenshot: false,
    pausePreservesMemory: true,
    deleteAfter: false,
    unsupported: {
      screenshot:
        "Agent37 serves no framebuffer: agent37-hermes has a headless browser, and a visible screen exists only as a noVNC desktop on a custom template, not as a PNG",
      deleteAfter:
        "Agent37 has no delete-after field; a leaked box is bounded by auto-sleep plus reconcile instead",
    },
    partial: {
      exec:
        "the sandbox exec endpoint answers once at exit, so onOutput receives the whole output in one chunk instead of live chunks",
      files:
        "list/putFile/getFile need the agent file API, which agent37-base, agent37-n8n, agent37-android and agent37-ubuntu do not serve; a directory holding more than 1000 entries is refused rather than half-listed, because the contract cannot carry the API's `truncated` flag",
    },
  };

  readonly #template: string;
  readonly #resources: Agent37ProviderOptions["resources"];
  readonly #region: Agent37ProviderOptions["region"];
  readonly #autoSleep: boolean;
  readonly #leakBackstop: boolean;
  readonly #idleTimeoutSeconds: number | undefined;
  readonly #provisionTimeoutMs: number;
  readonly #startTimeoutMs: number;

  constructor(options: Agent37ProviderOptions) {
    this.account = options.account;
    this.client = new Agent37Client({
      apiKey: options.apiKey,
      account: options.account,
      apiUrl: options.apiUrl,
      sandboxUrl: options.sandboxUrl,
      fetch: options.fetch,
    });
    this.#template = options.template ?? DEFAULT_TEMPLATE;
    this.#resources = options.resources;
    this.#region = options.region;
    this.#autoSleep = options.autoSleep ?? false;
    this.#leakBackstop = options.leakBackstop ?? true;
    this.#idleTimeoutSeconds = options.idleTimeoutSeconds;
    this.#provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  #ref(id: string): ComputerRef {
    return { provider: this.name, account: this.account, id };
  }

  /**
   * Create an instance and resolve only when it is `running`, per the contract's
   * obligation. Agent37's create already answers with the full instance object
   * once the machine has started, but it documents that the field can trail
   * reality around a wake, so this confirms with one read.
   *
   * Agent37 has no delete-after field (Instabox does), so a box leaked by a
   * crashed allocator would run and bill until someone noticed. The backstop is
   * auto-sleep: an orphan stops billing compute on its own, and reconcile then
   * destroys it. It is off by default, so a deployment that wants the allocator
   * to be the only thing that sleeps a box must accept that reconcile is what
   * bounds a leak.
   */
  async provision(options: ProvisionOptions = {}): Promise<ComputerRef> {
    const deadline = Date.now() + (options.timeoutMs ?? this.#provisionTimeoutMs);
    const autoSleep = this.#autoSleep || this.#leakBackstop;
    const body: Agent37CreateBody = {
      template: options.template ?? this.#template,
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#region ? { region: this.#region } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(autoSleep
        ? {
            auto_sleep: true,
            idle_timeout_seconds: clampIdle(this.#idleTimeoutSeconds ?? LEAK_BACKSTOP_IDLE_SECONDS),
          }
        : {}),
    };

    let created: Agent37Instance | undefined;
    try {
      created = await this.client.createInstance(body, { signal: options.signal, timeoutMs: remaining(deadline) });
      const instance = await this.#waitRunning(created.id, { deadline, signal: options.signal }, created);
      return this.#ref(instance.id);
    } catch (error) {
      // A create that fails after the instance exists would leak it. Deletes
      // debit nothing, so cleaning up is always worth the attempt.
      if (created?.id) await this.#deleteQuietly(created.id);
      throw asProviderError(error);
    }
  }

  /**
   * Wake or start, resolving only once an exec after it would succeed. This is
   * the contract's hardest obligation and Agent37 has the sharpest distinction:
   * `sleeping` is a checkpoint that keeps memory, `stopped` is memoryless, and
   * both are woken by `start`.
   */
  async start(ref: ComputerRef, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ComputerStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? this.#startTimeoutMs);
    let instance = await this.client.getInstance(ref.id, { signal: options.signal });

    if (instance.status === "deleted") throw notFound(ref.id);
    if (instance.status === "running") return mapStatus(instance);

    if (AGENT37_TRANSITIONAL.has(instance.status)) {
      instance = await this.#waitSettled(ref.id, deadline, options.signal);
      if (instance.status === "running") return mapStatus(instance);
    }

    // `stopped` and `sleeping` both need an explicit start. `start` on an already
    // running instance returns the same ack, so it is safe to send either way.
    try {
      await this.client.lifecycle(ref.id, "start", { signal: options.signal, timeoutMs: remaining(deadline) });
    } catch (error) {
      const providerError = asProviderError(error);
      // A sleep checkpoint being written answers 409 try_again for tens of
      // seconds; the box is waking underneath, so settle rather than give up.
      if (providerError.code !== "busy" || Date.now() >= deadline) throw providerError;
    }

    return mapStatus(await this.#waitRunning(ref.id, { deadline, signal: options.signal }));
  }

  /**
   * Sleep keeps memory and running processes and bills disk only, so it is the
   * provider's equivalent of Instabox's suspend. Sleeping an already sleeping
   * instance returns the same ack; any other state is a 400, so a stopped box is
   * left as it is (it already costs disk only).
   */
  async sleep(ref: ComputerRef): Promise<ComputerStatus> {
    const instance = await this.client.getInstance(ref.id);
    if (instance.status === "deleted") return mapStatus(instance);
    if (instance.status === "sleeping" || instance.status === "stopped") return mapStatus(instance);

    const deadline = Date.now() + this.#startTimeoutMs;
    const settled = AGENT37_TRANSITIONAL.has(instance.status)
      ? await this.#waitSettled(ref.id, deadline)
      : instance;

    if (settled.status === "sleeping" || settled.status === "stopped") return mapStatus(settled);
    if (settled.status !== "running") return mapStatus(settled);

    try {
      await this.client.lifecycle(ref.id, "sleep", { timeoutMs: remaining(deadline) });
    } catch (error) {
      const providerError = asProviderError(error);
      // A sleeping instance parked in cold storage cannot be stopped; it is
      // already costing disk only, which is all sleep was for.
      if (providerError.providerCode === "invalid_request") return mapStatus(settled);
      throw providerError;
    }
    return mapStatus(await this.client.getInstance(ref.id));
  }

  /**
   * Delete permanently, and resolve even for an instance that was already gone.
   * Agent37 deletes are cheap (`deleting` -> `deleted`), so this waits for the
   * id to stop resolving rather than leaving a box billing disk.
   */
  async destroy(ref: ComputerRef): Promise<void> {
    try {
      await this.client.deleteInstance(ref.id);
    } catch (error) {
      if (asProviderError(error).code === "not_found") return;
      throw asProviderError(error);
    }

    // Agent37 deletes are cheap (`deleting` -> `deleted`), so wait for the id to
    // stop resolving. A box that outlives the deadline is reported rather than
    // resolved: an instance that still resolves is still billing disk, and a
    // caller that believed it gone would never look at it again.
    const deadline = Date.now() + 120_000;
    for (;;) {
      let instance: Agent37Instance;
      try {
        instance = await this.client.getInstance(ref.id);
      } catch (error) {
        if (asProviderError(error).code === "not_found") return;
        throw asProviderError(error);
      }
      if (instance.status === "deleted") return;
      if (Date.now() >= deadline) {
        throw new ProviderError(
          "unavailable",
          `Agent37 still reports ${ref.id} as ${instance.status} after the delete deadline`,
          { providerCode: "delete_timeout", retryable: true },
        );
      }
      await sleep(500);
    }
  }

  /**
   * Run a command through the sandbox plane, which answers in a couple hundred
   * milliseconds because it is the instance's own machine.
   */
  async exec(ref: ComputerRef, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const seconds = clamp(options.timeoutSeconds ?? 60, 1, 900);

    let wrapped = command;
    // A `KEY=v cmd` prefix only scopes the variable to that one simple command,
    // so `KEY=v cd /d && run` would leave `run` without it. Exports reach the
    // whole shell, which is what a caller means.
    if (options.env && Object.keys(options.env).length > 0) {
      const exports = Object.entries(options.env)
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join("; ");
      wrapped = `${exports}; ${wrapped}`;
    }
    // Prepended last so it runs first: a cwd that does not exist fails the whole
    // call instead of running the command somewhere else, and nothing after it
    // runs at all.
    if (options.cwd) wrapped = `cd ${shellQuote(options.cwd)} || exit 1; ${wrapped}`;
    // The sandbox exec endpoint has no timeout field of its own: it waits up to
    // 15 minutes and then answers, leaving the command running. The wrapper goes
    // on every call, not only on the ones that asked for a deadline, so an
    // abandoned command cannot outlive the request that started it.
    wrapped = `timeout ${seconds}s sh -c ${shellQuote(wrapped)}`;

    const started = Date.now();
    let result: Agent37ExecResult;
    try {
      result = await this.client.exec(ref.id, wrapped, {
        signal: options.signal,
        timeoutMs: (seconds + 60) * 1000,
      });
    } catch (error) {
      const providerError = asProviderError(error);
      if (providerError.code === "timeout" && Date.now() - started >= seconds * 1000) {
        return { stdout: "", stderr: "", exitCode: 124, timedOut: true, truncated: false };
      }
      throw providerError;
    }

    // The endpoint answers once, at exit, so there are no chunks to deliver
    // while the command runs: the whole output goes to onOutput as one chunk
    // rather than being dropped, and `capabilities.partial.exec` says so.
    if (options.onOutput) {
      if (result.stdout) options.onOutput({ stream: "stdout", text: result.stdout });
      if (result.stderr) options.onOutput({ stream: "stderr", text: result.stderr });
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
      timedOut: result.exit_code === 124,
      truncated: result.truncated,
    };
  }

  /**
   * Write bytes to the instance's disk through the agent template's file API.
   * That API exists only on an agent template; a template without it says so
   * instead of falling back to base64 through exec, which would be silently
   * capped.
   */
  async putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void> {
    const base = await this.#instanceUrl(ref);
    const url = new URL("/v1/files/content", base);
    url.searchParams.set("path", path);
    const response = await this.client.requestRaw("PUT", url.toString(), {
      body: typeof data === "string" ? data : Buffer.from(data),
    });
    if (response.ok) return;
    throw await this.#fileError(response, `Agent37 could not write ${path}`);
  }

  /**
   * Read bytes back. No 512 KB exec cap: the file API streams any size.
   */
  async getFile(ref: ComputerRef, path: string): Promise<Uint8Array> {
    const base = await this.#instanceUrl(ref);
    const url = new URL("/v1/files/content", base);
    url.searchParams.set("path", path);
    url.searchParams.set("disposition", "attachment");
    const response = await this.client.requestRaw("GET", url.toString());
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    throw await this.#fileError(response, `Agent37 could not read ${path}`);
  }

  /**
   * One directory level through the agent template's file API. A template with
   * no file endpoints reports the capability as missing instead of returning an
   * empty list that would read as "nothing is here".
   */
  async list(ref: ComputerRef, path: string): Promise<FileEntry[]> {
    const base = await this.#instanceUrl(ref);
    const url = new URL("/v1/files", base);
    if (path) url.searchParams.set("path", path);
    const response = await this.client.requestRaw("GET", url.toString());
    if (!response.ok) throw await this.#fileError(response, `Agent37 could not list ${path || "~"}`);

    const body = (await response.json()) as {
      entries?: Array<{ name: string; type: string; size: number | null; modified: number }>;
      truncated?: boolean;
    };
    // The file API returns at most 1000 entries and says so with `truncated`.
    // The contract's `list` has nowhere to carry that flag, and a short list
    // reads as a complete directory, so refuse rather than under-report: the
    // caller narrows the path and gets a real answer.
    if (body.truncated) {
      throw new ProviderError(
        "bad_request",
        `Agent37 truncated the listing of ${path || "~"}: 1000 entries is one page, so list a narrower path`,
        { providerCode: "listing_truncated" },
      );
    }
    return (body.entries ?? []).map((entry) => ({
      name: entry.name,
      type:
        entry.type === "directory"
          ? "dir"
          : entry.type === "symlink"
            ? "symlink"
            : entry.type === "file"
              ? "file"
              : "other",
      size: entry.size ?? 0,
      // Agent37 reports no mode; an empty string says so rather than inventing
      // one a caller might branch on.
      mode: "",
      modifiedAt: new Date(entry.modified).toISOString(),
    }));
  }

  /** The instance's own URL, which is where its file API lives. */  async #instanceUrl(ref: ComputerRef): Promise<string> {
    const instance = await this.client.getInstance(ref.id);
    if (!instance.url) throw notFound(ref.id);
    if (instance.template && !hasFileApi(instance.template)) {
      throw unsupported(
        "files",
        `the ${instance.template} template has no file API; use exec or SSH instead`,
      );
    }
    return instance.url;
  }

  async #fileError(response: Response, fallback: string): Promise<ProviderError> {
    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const error = providerErrorFrom(response.status, parsed, fallback);
    // A path that does not exist is `not_found` on the instance plane, but the
    // allocator reads `not_found` as "the computer is gone". Keep the computer
    // and report the path.
    if (error.providerCode === "file_not_found") {
      return new ProviderError("bad_request", `no file at that path`, {
        providerCode: "file_not_found",
        status: response.status,
      });
    }
    return error;
  }

  /**
   * Not supported. Agent37 serves no framebuffer: `agent37-hermes` has a
   * headless browser, and a visible screen only exists on a custom
   * `hermes-vnc-desktop` template as a noVNC session, not as a PNG. See
   * AGENT37_UNSUPPORTED.
   */
  async screenshot(_ref: ComputerRef): Promise<Screenshot> {
    throw unsupported(
      "screenshot",
      "no screenshot endpoint; a visible screen exists only as a noVNC desktop on a custom template, not as a PNG",
    );
  }

  async status(ref: ComputerRef): Promise<ComputerStatus> {
    try {
      return mapStatus(await this.client.getInstance(ref.id));
    } catch (error) {
      throw asProviderError(error);
    }
  }

  /**
   * No lease concept. Agent37 counts any exec or URL traffic as activity, so
   * this touches the instance through exec — which both resets the idle timer
   * and proves the box is still reachable — and reports an expiry the allocator
   * can store. The expiry is the provider's own idle window, which is the only
   * duration Agent37 understands.
   */
  async lease(ref: ComputerRef, leaseId: string, ttlSeconds = 300): Promise<ActivityLease> {
    const result = await this.client.exec(ref.id, "true", { timeoutMs: 30_000 });
    if (result.exit_code !== 0) {
      throw new ProviderError("not_running", `Agent37 refused activity on ${ref.id}`, {
        providerCode: "lease_failed",
      });
    }
    const window = this.#autoSleep ? (this.#idleTimeoutSeconds ?? 900) : ttlSeconds;
    return {
      id: leaseId,
      expiresAt: new Date(Date.now() + Math.min(clamp(ttlSeconds, 30, 3600), window) * 1000).toISOString(),
    };
  }

  /** Nothing to release: the lease is advisory and the box sleeps on its own. */
  async releaseLease(_ref: ComputerRef, _leaseId: string): Promise<void> {
    return;
  }

  async listComputers(): Promise<Array<ComputerRef & { name: string; status: ComputerStatus; metadata?: Record<string, string> }>> {
    const instances = await this.client.listInstances();
    return instances
      .filter((instance) => instance.status !== "deleted")
      .map((instance) => ({
        ...this.#ref(instance.id),
        name: instance.name ?? instance.id,
        metadata: instance.metadata ?? {},
        status: mapStatus(instance),
      }));
  }

  async #waitRunning(
    id: string,
    options: { deadline: number; signal?: AbortSignal },
    known?: Agent37Instance,
  ): Promise<Agent37Instance> {
    let instance = known ?? (await this.client.getInstance(id, { signal: options.signal }));
    while (instance.status !== "running") {
      if (instance.status === "deleted") throw notFound(id);
      if (instance.status === "failed") {
        const reason = instance.status_reason;
        throw new ProviderError("unavailable", reason?.message ?? `instance ${id} failed`, {
          providerCode: reason?.code ?? "failed",
        });
      }
      if (Date.now() >= options.deadline) {
        throw new ProviderError("timeout", `instance ${id} stayed ${instance.status}`, {
          providerCode: "ready_timeout",
        });
      }
      await sleep(700);
      instance = await this.client.getInstance(id, { signal: options.signal });
    }
    return instance;
  }

  async #waitSettled(id: string, deadline: number, signal?: AbortSignal): Promise<Agent37Instance> {
    let instance = await this.client.getInstance(id, { signal });
    while (AGENT37_TRANSITIONAL.has(instance.status)) {
      if (Date.now() >= deadline) {
        throw new ProviderError("timeout", `instance ${id} stayed ${instance.status}`, {
          providerCode: "operation_timeout",
        });
      }
      await sleep(700);
      instance = await this.client.getInstance(id, { signal });
    }
    return instance;
  }

  async #deleteQuietly(id: string): Promise<void> {
    try {
      await this.client.deleteInstance(id);
    } catch {
      // Best effort: the caller's original error is the news.
    }
  }
}

/** Templates that serve the agent's file API; the base and app templates do not. */
function hasFileApi(template: string): boolean {
  const name = template.split("@")[0] ?? template;
  return name !== "agent37-base" && name !== "agent37-n8n" && name !== "agent37-android" && name !== "agent37-ubuntu";
}

function notFound(id: string): ProviderError {
  return new ProviderError("not_found", `computer ${id} is gone`);
}

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}

const NATIVE_STATES: Record<string, ComputerState> = {
  provisioning: "provisioning",
  starting: "starting",
  restarting: "starting",
  waking: "starting",
  updating: "starting",
  running: "running",
  sleeping: "sleeping",
  stopping: "stopped",
  stopped: "stopped",
  failed: "error",
  deleting: "destroyed",
  deleted: "destroyed",
};

/**
 * Map Agent37's state onto the contract's. `ready` is true only for `running`:
 * Agent37 documents that around a wake the status can trail reality, so the
 * health check an agent template exposes is what proves the gateway, not the
 * container — and `start` is what guarantees a following exec.
 */
export function mapStatus(instance: Agent37Instance): ComputerStatus {
  const state = NATIVE_STATES[instance.status] ?? "error";
  return {
    state,
    raw: instance.status,
    ready: instance.status === "running",
    // A sleeping Agent37 instance is a checkpoint that keeps memory and running
    // processes; a stopped one is memoryless, so only `sleeping` may claim this.
    ...(state === "sleeping" ? { processesPreserved: true } : {}),
    idleTimeoutSeconds: instance.auto_sleep ? (instance.idle_timeout_seconds ?? 900) : null,
    maxRunMinutes: null,
    autoSleptAt: instance.slept_at ? new Date(instance.slept_at * 1000).toISOString() : null,
    ...(instance.created ? { createdAt: new Date(instance.created * 1000).toISOString() } : {}),
    ...(instance.status === "failed" && instance.status_reason
      ? {
          error: {
            providerCode: instance.status_reason.code,
            message: instance.status_reason.message ?? instance.status_reason.code,
          },
        }
      : {}),
  };
}

function remaining(deadline: number): number {
  return Math.max(1000, deadline - Date.now());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Agent37 accepts an idle window of 300 s to 86400 s. */
function clampIdle(seconds: number): number {
  return clamp(Math.round(seconds), 300, 86_400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
