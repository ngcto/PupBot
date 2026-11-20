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
  ProvisionOptions,
  Screenshot,
} from "../contract.ts";
import { InstaboxClient, providerErrorFrom } from "./client.ts";
import type { InstaboxMachine } from "./client.ts";

export interface InstaboxProviderOptions {
  /** Pool account key, e.g. "instabox:acct-1". Capacity is counted per account. */
  account: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Free-plan-safe default is the template every plan can create from. */
  template?: string;
  size?: { vcpus: number; memMiB: number };
  idleTimeoutSeconds?: number;
  /** Backstop so a crashed allocator leaks a box for hours, not weeks. */
  ttlSeconds?: number;
  provisionTimeoutMs?: number;
  startTimeoutMs?: number;
  screenshotTimeoutMs?: number;
}

const DEFAULT_TEMPLATE = "agent-browser";
const DEFAULT_TTL_SECONDS = 3 * 60 * 60;
const DEFAULT_PROVISION_TIMEOUT_MS = 180_000;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000;
/** A uniform 1280x800 frame compresses to ~3 KB; a painted desktop is ~100 KB. */
const PAINTED_PNG_BYTES = 8 * 1024;
const SHOT_PATH = "/tmp/pupbot-shot.png";

const TRANSITIONAL = new Set(["creating", "starting", "resuming", "stopping", "suspending"]);

/**
 * The Instabox implementation of the provider contract.
 *
 * Two rules come from the provider's measured behaviour and shape every method:
 * `provision` does not resolve until the box accepts commands, and `start` does
 * not resolve until an exec after it would work. Callers get "await start();
 * await exec(...)" with no retry loop of their own.
 */
export class InstaboxProvider implements ComputerProvider {
  readonly name = "instabox";
  readonly account: string;
  readonly client: InstaboxClient;

  readonly #template: string;
  readonly #size: { vcpus: number; memMiB: number } | undefined;
  readonly #idleTimeoutSeconds: number | undefined;
  readonly #ttlSeconds: number;
  readonly #provisionTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #screenshotTimeoutMs: number;

  constructor(options: InstaboxProviderOptions) {
    this.account = options.account;
    this.client = new InstaboxClient({
      apiKey: options.apiKey,
      account: options.account,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });
    this.#template = options.template ?? DEFAULT_TEMPLATE;
    this.#size = options.size;
    this.#idleTimeoutSeconds = options.idleTimeoutSeconds;
    this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#screenshotTimeoutMs = options.screenshotTimeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS;
  }

  #ref(id: string): ComputerRef {
    return { provider: this.name, account: this.account, id };
  }

  async provision(options: ProvisionOptions = {}): Promise<ComputerRef> {
    const timeoutMs = options.timeoutMs ?? this.#provisionTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const body: Record<string, unknown> = {
      templateId: options.template ?? this.#template,
      deleteAfterSeconds: options.ttlSeconds ?? this.#ttlSeconds,
      metadata: options.metadata ?? {},
    };
    const size = options.size ?? this.#size;
    if (size) {
      body.vcpus = size.vcpus;
      body.memMiB = size.memMiB;
    }
    const idle = options.idleTimeoutSeconds ?? this.#idleTimeoutSeconds;
    if (idle !== undefined) body.autoSuspendAfterSeconds = idle;

    let machineId: string | undefined;
    try {
      const operation = await this.client.createMachine(body, { signal: options.signal, timeoutMs: 30_000 });
      machineId = operation.machineId;
      await this.client.waitForOperation(operation, { signal: options.signal, timeoutMs: remaining(deadline) });
      await this.#waitReady(machineId, { deadline, signal: options.signal });
      return this.#ref(machineId);
    } catch (error) {
      // A create that fails after the box exists would leak it; the spike hit
      // exactly that. Deleting is best effort, the original error is the news.
      if (machineId) await this.#deleteQuietly(machineId);
      throw asProviderError(error);
    }
  }

  async start(ref: ComputerRef, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ComputerStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? this.#startTimeoutMs);
    let machine = await this.client.getMachine(ref.id, { signal: options.signal });
    if (isReady(machine)) return mapStatus(machine);

    if (TRANSITIONAL.has(machine.state)) {
      machine = await this.#waitSettled(ref.id, deadline, options.signal);
      if (isReady(machine)) return mapStatus(machine);
    }

    try {
      await this.#wake(ref.id, machine, deadline, options.signal);
    } catch (error) {
      const providerError = asProviderError(error);
      // A wake can race another caller's operation. Wait it out, then retry once.
      if (providerError.code !== "busy" || Date.now() >= deadline) throw providerError;
      machine = await this.#waitSettled(ref.id, deadline, options.signal);
      if (isReady(machine)) return mapStatus(machine);
      await this.#wake(ref.id, machine, deadline, options.signal);
    }

    return mapStatus(await this.#waitReady(ref.id, { deadline, signal: options.signal }));
  }

  async sleep(ref: ComputerRef): Promise<ComputerStatus> {
    const deadline = Date.now() + this.#startTimeoutMs;
    let machine = await this.client.getMachine(ref.id);
    if (machine.state === "deleted" || machine.state === "deleting") return mapStatus(machine);
    if (TRANSITIONAL.has(machine.state)) machine = await this.#waitSettled(ref.id, deadline);

    if (machine.state === "suspended" || machine.state === "stopped") return mapStatus(machine);
    if (machine.state === "running" || machine.state === "error") {
      const operation = await this.client.suspendMachine(ref.id);
      await this.client.waitForOperation(operation, { timeoutMs: remaining(deadline) });
      return mapStatus(await this.client.getMachine(ref.id));
    }
    // Starting or resuming slipped through; let it settle, then pause it.
    machine = await this.#waitSettled(ref.id, deadline);
    if (machine.state === "running") {
      const operation = await this.client.suspendMachine(ref.id);
      await this.client.waitForOperation(operation, { timeoutMs: remaining(deadline) });
      return mapStatus(await this.client.getMachine(ref.id));
    }
    return mapStatus(machine);
  }

  async destroy(ref: ComputerRef): Promise<void> {
    try {
      const operation = await this.client.deleteMachine(ref.id);
      await this.client.waitForOperation(operation, { timeoutMs: 120_000 });
    } catch (error) {
      const providerError = asProviderError(error);
      if (providerError.code === "not_found") return;
      if (providerError.code === "busy") {
        // Another operation is in flight; the provider cancels a queued one, so
        // one retry after it settles is enough.
        await this.client.getMachine(ref.id).catch(() => undefined);
        const retry = await this.client.deleteMachine(ref.id).catch((next: unknown) => {
          const code = asProviderError(next).code;
          if (code === "not_found") return undefined;
          throw next;
        });
        if (retry) await this.client.waitForOperation(retry, { timeoutMs: 120_000 });
        return;
      }
      throw providerError;
    }
  }

  async exec(ref: ComputerRef, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const body: Record<string, unknown> = { cmd: command };
    if (options.cwd) body.cwd = options.cwd;
    if (options.env) body.envs = options.env;
    const seconds = clamp(options.timeoutSeconds ?? 60, 1, 600);
    body.timeoutSeconds = seconds;
    // The box itself can stall ~30 s; leave the HTTP request room over its own cap.
    const requestOptions = { signal: options.signal, timeoutMs: (seconds + 60) * 1000 };

    const result = options.onOutput
      ? await this.client.execStream(ref.id, body, options.onOutput, requestOptions)
      : await this.client.exec(ref.id, body, requestOptions);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }

  async putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void> {
    await this.client.writeFile(ref.id, path, data);
  }

  async getFile(ref: ComputerRef, path: string): Promise<Uint8Array> {
    return this.client.readFile(ref.id, path);
  }

  async list(ref: ComputerRef, path: string): Promise<FileEntry[]> {
    const files = await this.client.listFiles(ref.id, path);
    if (files.type === "file") {
      return [
        {
          name: files.path.split("/").pop() ?? files.path,
          type: "file",
          size: files.size ?? 0,
          mode: files.mode ?? "",
          modifiedAt: files.modTime ?? new Date().toISOString(),
        },
      ];
    }
    return (files.entries ?? []).map((entry) => ({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      modifiedAt: entry.modTime,
      ...(entry.target ? { target: entry.target } : {}),
    }));
  }

  async screenshot(ref: ComputerRef): Promise<Screenshot> {
    const deadline = Date.now() + this.#screenshotTimeoutMs;
    let desktopStarted = false;

    while (Date.now() < deadline) {
      if (!desktopStarted) {
        const desktop = await this.client.desktop(ref.id, { action: "start", width: 1280, height: 800 });
        if (!desktop.installed) {
          // Not installed: ask for the install and come back; it takes ~30 s.
          await this.client.desktop(ref.id, { action: "install" });
          await sleep(1500);
          continue;
        }
        desktopStarted = desktop.running;
        if (!desktopStarted) {
          await sleep(500);
          continue;
        }
      }

      const capture = await this.client.exec(
        ref.id,
        { cmd: CAPTURE_SCRIPT, timeoutSeconds: 60 },
        { timeoutMs: 120_000 },
      );
      if (capture.exitCode === 0) {
        const png = await this.client.readFile(ref.id, SHOT_PATH);
        // MEASURED: the first frames after a desktop start are a solid black
        // PNG (~3 KB) because the Xfce session has not painted yet.
        if (png.byteLength >= PAINTED_PNG_BYTES) {
          return { png, takenAt: new Date().toISOString() };
        }
      }
      await sleep(700);
    }

    throw new ProviderError("timeout", "the desktop did not paint in time", { providerCode: "screenshot_blank" });
  }

  async status(ref: ComputerRef): Promise<ComputerStatus> {
    return mapStatus(await this.client.getMachine(ref.id));
  }

  async lease(ref: ComputerRef, leaseId: string, ttlSeconds = 300): Promise<ActivityLease> {
    const lease = await this.client.putLease(ref.id, leaseId, clamp(ttlSeconds, 30, 3600));
    return { id: lease.id, expiresAt: lease.expiresAt };
  }

  async releaseLease(ref: ComputerRef, leaseId: string): Promise<void> {
    await this.client.deleteLease(ref.id, leaseId);
  }

  async listComputers(): Promise<
    Array<ComputerRef & { name: string; status: ComputerStatus; metadata?: Record<string, string> }>
  > {
    const machines = await this.client.listMachines();
    // Reconcile adopts by `metadata.botId`, which the contract's return type
    // omits; carrying it through is what makes an orphan recoverable.
    return machines.map((machine) => ({
      ...this.#ref(machine.id),
      name: machine.name ?? machine.id,
      metadata: machine.metadata ?? {},
      status: mapStatus(machine),
    }));
  }

  async #wake(id: string, machine: InstaboxMachine, deadline: number, signal?: AbortSignal): Promise<void> {
    if (machine.state === "deleted" || machine.state === "deleting") {
      throw new ProviderError("not_found", `computer ${id} is gone`);
    }
    if (machine.state === "suspended") {
      const operation = await this.client.resumeMachine(id);
      await this.client.waitForOperation(operation, { signal, timeoutMs: remaining(deadline) });
      return;
    }
    if (machine.state === "stopped" || machine.state === "error") {
      const operation = await this.client.startMachine(id);
      await this.client.waitForOperation(operation, { signal, timeoutMs: remaining(deadline) });
      return;
    }
    // Running but not ready (a host that stopped answering, or a box still
    // finishing its boot): fall through and wait for ready.
  }

  async #waitReady(id: string, options: { deadline: number; signal?: AbortSignal }): Promise<InstaboxMachine> {
    let last: InstaboxMachine | undefined;
    while (Date.now() < options.deadline) {
      const machine = await this.client.getMachine(id, { signal: options.signal });
      last = machine;
      if (isReady(machine)) return machine;
      if (machine.state === "error") {
        throw providerErrorFrom(500, machine.lastError ?? { code: "error", message: "the box reported an error" });
      }
      if (machine.state === "deleted" || machine.state === "deleting") {
        throw new ProviderError("not_found", `computer ${id} disappeared while starting`);
      }
      if (machine.state === "stopped" || machine.state === "suspended") {
        throw new ProviderError("not_running", `computer ${id} is ${machine.state}; start it again`, {
          providerCode: machine.state,
        });
      }
      await sleep(400);
    }
    throw new ProviderError("timeout", `computer ${id} did not become ready`, {
      providerCode: last?.runtime?.hostUnreachable ? "host_unreachable" : "ready_timeout",
    });
  }

  async #waitSettled(id: string, deadline: number, signal?: AbortSignal): Promise<InstaboxMachine> {
    let machine = await this.client.getMachine(id, { signal });
    while (TRANSITIONAL.has(machine.state)) {
      if (Date.now() >= deadline) {
        throw new ProviderError("timeout", `computer ${id} stayed ${machine.state}`, {
          providerCode: "operation_timeout",
        });
      }
      await sleep(400);
      machine = await this.client.getMachine(id, { signal });
    }
    return machine;
  }

  async #deleteQuietly(id: string): Promise<void> {
    try {
      await this.client.deleteMachine(id);
    } catch {
      // Cleanup is best effort: the box also carries a delete deadline.
    }
  }
}

const CAPTURE_SCRIPT = `set -u
for tool in scrot import ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || continue
  case "$tool" in
    scrot)  scrot -o -z -d :1 ${SHOT_PATH} && exit 0 ;;
    import) DISPLAY=:1 import -window root ${SHOT_PATH} && exit 0 ;;
    ffmpeg) DISPLAY=:1 ffmpeg -loglevel error -f x11grab -video_size 1280x800 -i :1 -frames:v 1 -y ${SHOT_PATH} && exit 0 ;;
  esac
done
echo "no screen capture tool (scrot, import or ffmpeg) in the box" >&2
exit 1`;

const NATIVE_STATES: Record<string, ComputerState> = {
  creating: "provisioning",
  starting: "starting",
  resuming: "starting",
  running: "running",
  suspending: "sleeping",
  suspended: "sleeping",
  stopping: "stopped",
  stopped: "stopped",
  deleting: "destroyed",
  deleted: "destroyed",
  error: "error",
};

export function mapStatus(machine: InstaboxMachine): ComputerStatus {
  const state = NATIVE_STATES[machine.state] ?? "error";
  return {
    state,
    raw: machine.state,
    ready: isReady(machine),
    ...(machine.runtime?.processesPreserved !== undefined
      ? { processesPreserved: machine.runtime.processesPreserved }
      : {}),
    idleTimeoutSeconds: machine.autoSuspendAfterSeconds ?? null,
    maxRunMinutes: machine.maxRunMinutes ?? null,
    autoSleptAt: machine.autoSuspendedAt ?? null,
    ...(machine.createdAt ? { createdAt: machine.createdAt } : {}),
    ...(machine.lastError
      ? { error: { providerCode: machine.lastError.code, message: machine.lastError.message ?? machine.lastError.code } }
      : {}),
  };
}

function isReady(machine: InstaboxMachine): boolean {
  return machine.state === "running" && machine.runtime?.ready === true && machine.runtime.hostUnreachable !== true;
}

function remaining(deadline: number): number {
  return Math.max(1_000, deadline - Date.now());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}
