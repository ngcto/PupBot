import { ProviderError } from "./contract.ts";
import type {
  ActivityLease,
  ComputerProvider,
  ComputerRef,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
  ProvisionOptions,
} from "./contract.ts";

/** Every provider method a fake can be told to fail on. */
export type FakeOperation =
  | "provision"
  | "start"
  | "sleep"
  | "destroy"
  | "exec"
  | "putFile"
  | "getFile"
  | "list"
  | "screenshot"
  | "status"
  | "lease"
  | "releaseLease"
  | "listComputers";

export interface FakeFailure {
  operation: FakeOperation;
  /** Thrown for the next `times` matching calls (default 1). */
  error: ProviderError;
  times?: number;
}

export interface FakeProviderOptions {
  account?: string;
  /** Per-operation delay, so a caller's timeout paths can be exercised. */
  latencyMs?: Partial<Record<FakeOperation, number>>;
  /** Scripted failures, consumed in order. */
  failures?: FakeFailure[];
  /**
   * Treat an unknown computer id as one of ours in the running state. The fake
   * keeps its boxes in one process' memory, and the web app and the worker are
   * separate processes: with this on, a box provisioned by one is usable from
   * the other. Off by default, so the contract test still sees `not_found`.
   */
  adoptUnknownIds?: boolean;
  /** A one-pixel PNG stands in for the desktop. */
  blankScreenshot?: boolean;
}

interface FakeBox {
  ref: ComputerRef;
  state: ComputerStatus["state"];
  metadata: Record<string, string>;
  files: Map<string, { data: Uint8Array; modifiedAt: string; mode: string }>;
  leases: Map<string, number>;
  createdAt: string;
  processesPreserved: boolean;
}

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * An in-memory provider with the same obligations as a real one, used by the
 * allocator tests, the browser tests and local development. It can be told to
 * fail a given operation with a given `ProviderError`, which is how the retry
 * and give-up rules are tested without touching a network.
 */
export class FakeComputerProvider implements ComputerProvider {
  readonly name = "fake";
  readonly account: string;

  readonly calls: Record<FakeOperation, number> = {
    provision: 0,
    start: 0,
    sleep: 0,
    destroy: 0,
    exec: 0,
    putFile: 0,
    getFile: 0,
    list: 0,
    screenshot: 0,
    status: 0,
    lease: 0,
    releaseLease: 0,
    listComputers: 0,
  };

  #boxes = new Map<string, FakeBox>();
  #counter = 0;
  #failures: FakeFailure[];
  #latency: Partial<Record<FakeOperation, number>>;
  #adoptUnknownIds: boolean;
  #blankScreenshot: boolean;
  #execOutput: ((command: string) => ExecResult | undefined) | undefined;

  constructor(options: FakeProviderOptions = {}) {
    this.account = options.account ?? "fake";
    this.#failures = (options.failures ?? []).map((failure) => ({ ...failure }));
    this.#latency = options.latencyMs ?? {};
    this.#adoptUnknownIds = options.adoptUnknownIds ?? false;
    this.#blankScreenshot = options.blankScreenshot ?? false;
  }

  /** Add or replace a failure script mid-test. */
  fail(operation: FakeOperation, error: ProviderError, times = 1): void {
    this.#failures.push({ operation, error, times });
  }

  /** Let a test script exec output; the default echoes the command. */
  onExec(handler: (command: string) => ExecResult | undefined): void {
    this.#execOutput = handler;
  }

  boxIds(): string[] {
    return [...this.#boxes.keys()];
  }

  stateOf(id: string): ComputerStatus["state"] | undefined {
    return this.#boxes.get(id)?.state;
  }

  async provision(options: ProvisionOptions = {}): Promise<ComputerRef> {
    await this.#enter("provision");
    this.#counter += 1;
    const ref: ComputerRef = { provider: this.name, account: this.account, id: `${this.account}-box-${this.#counter}` };
    if (options.signal?.aborted) throw new ProviderError("timeout", "provision aborted");
    this.#boxes.set(ref.id, {
      ref,
      state: "running",
      metadata: options.metadata ?? {},
      files: new Map(),
      leases: new Map(),
      createdAt: new Date().toISOString(),
      processesPreserved: true,
    });
    return ref;
  }

  async start(ref: ComputerRef, options: { timeoutMs?: number } = {}): Promise<ComputerStatus> {
    await this.#enter("start");
    const box = this.#require(ref);
    if (box.state === "running") return this.status(ref);
    if (box.state === "destroyed") throw new ProviderError("not_found", `no computer ${ref.id}`);
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new ProviderError("timeout", `computer ${ref.id} did not wake`);
    }
    box.state = "running";
    return this.status(ref);
  }

  async sleep(ref: ComputerRef): Promise<ComputerStatus> {
    await this.#enter("sleep");
    const box = this.#require(ref);
    if (box.state === "running") box.state = "sleeping";
    return this.status(ref);
  }

  async destroy(ref: ComputerRef): Promise<void> {
    await this.#enter("destroy");
    const box = this.#boxes.get(ref.id);
    if (!box) return;
    box.state = "destroyed";
    this.#boxes.delete(ref.id);
  }

  async exec(ref: ComputerRef, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    await this.#enter("exec");
    const box = this.#require(ref);
    if (box.state !== "running") {
      throw new ProviderError("not_running", `${ref.id} is ${box.state}; start it first`);
    }
    const result = this.#execOutput?.(command) ?? defaultExec(box, command);
    if (result.stdout) options.onOutput?.({ stream: "stdout", text: result.stdout });
    if (options.signal?.aborted) {
      return { ...result, exitCode: 124, timedOut: true };
    }
    return result;
  }

  async putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void> {
    await this.#enter("putFile");
    const box = this.#require(ref);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    box.files.set(path, { data: bytes, modifiedAt: new Date().toISOString(), mode: "0644" });
  }

  async getFile(ref: ComputerRef, path: string): Promise<Uint8Array> {
    await this.#enter("getFile");
    const box = this.#require(ref);
    const file = box.files.get(path);
    if (!file) throw new ProviderError("not_found", `no file at ${path}`);
    return file.data;
  }

  async list(ref: ComputerRef, path: string): Promise<FileEntry[]> {
    await this.#enter("list");
    const box = this.#require(ref);
    const direct = box.files.get(path);
    if (direct) {
      return [
        {
          name: path.split("/").pop() ?? path,
          type: "file",
          size: direct.data.byteLength,
          mode: direct.mode,
          modifiedAt: direct.modifiedAt,
        },
      ];
    }
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...box.files.entries()]
      .filter(([filePath]) => filePath.startsWith(prefix))
      .map(([filePath, file]) => ({
        name: filePath.slice(prefix.length),
        type: "file" as const,
        size: file.data.byteLength,
        mode: file.mode,
        modifiedAt: file.modifiedAt,
      }));
  }

  async screenshot(ref: ComputerRef): Promise<{ png: Uint8Array; takenAt: string }> {
    await this.#enter("screenshot");
    this.#require(ref);
    if (this.#blankScreenshot) {
      const png = new Uint8Array(3072);
      return { png, takenAt: new Date().toISOString() };
    }
    return { png: ONE_PIXEL_PNG, takenAt: new Date().toISOString() };
  }

  async status(ref: ComputerRef): Promise<ComputerStatus> {
    await this.#enter("status");
    const box = this.#require(ref);
    return {
      state: box.state,
      raw: box.state,
      ready: box.state === "running",
      processesPreserved: box.processesPreserved,
      idleTimeoutSeconds: 1800,
      maxRunMinutes: 480,
      autoSleptAt: null,
      createdAt: box.createdAt,
    };
  }

  async lease(ref: ComputerRef, leaseId: string, ttlSeconds = 300): Promise<ActivityLease> {
    await this.#enter("lease");
    const box = this.#require(ref);
    if (box.state === "sleeping") box.state = "running";
    if (box.state !== "running") throw new ProviderError("not_running", `${ref.id} is ${box.state}`);
    const ttl = Math.min(Math.max(ttlSeconds, 30), 3600);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    box.leases.set(leaseId, Date.now() + ttl * 1000);
    return { id: leaseId, expiresAt };
  }

  async releaseLease(ref: ComputerRef, leaseId: string): Promise<void> {
    await this.#enter("releaseLease");
    this.#boxes.get(ref.id)?.leases.delete(leaseId);
  }

  async listComputers(): Promise<Array<ComputerRef & { name: string; status: ComputerStatus }>> {
    await this.#enter("listComputers");
    return [...this.#boxes.values()].map((box) => ({
      ...box.ref,
      name: box.ref.id,
      metadata: box.metadata,
      status: {
        state: box.state,
        raw: box.state,
        ready: box.state === "running",
        createdAt: box.createdAt,
      },
    }));
  }

  #require(ref: ComputerRef): FakeBox {
    const box = this.#boxes.get(ref.id);
    if (box) return box;
    if (!this.#adoptUnknownIds) throw new ProviderError("not_found", `no computer ${ref.id}`);
    const adopted: FakeBox = {
      ref,
      state: "running",
      metadata: {},
      files: new Map(),
      leases: new Map(),
      createdAt: new Date().toISOString(),
      processesPreserved: true,
    };
    this.#boxes.set(ref.id, adopted);
    return adopted;
  }

  async #enter(operation: FakeOperation): Promise<void> {
    this.calls[operation] += 1;
    const latency = this.#latency[operation];
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
    const index = this.#failures.findIndex((failure) => failure.operation === operation);
    if (index === -1) return;
    const failure = this.#failures[index]!;
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) this.#failures.splice(index, 1);
    throw failure.error;
  }
}

function defaultExec(box: FakeBox, command: string): ExecResult {
  const ok = { stderr: "", timedOut: false, truncated: false };
  const trimmed = command.trim();
  if (trimmed.startsWith("exit ")) {
    return { ...ok, stdout: "", exitCode: Number(trimmed.split(/\s+/)[1] ?? 1) };
  }
  if (trimmed === "false") return { ...ok, stdout: "", exitCode: 1 };
  if (trimmed.startsWith("echo ")) {
    return { ...ok, stdout: `${trimmed.slice(5).replace(/^["']|["']$/g, "")}\n`, exitCode: 0 };
  }
  if (trimmed.startsWith("cat ")) {
    const file = box.files.get(trimmed.slice(4).trim());
    return { ...ok, stdout: file ? new TextDecoder().decode(file.data) : "", exitCode: file ? 0 : 1 };
  }
  return { ...ok, stdout: "", exitCode: 0 };
}
