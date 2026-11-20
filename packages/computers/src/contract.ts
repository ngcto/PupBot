/**
 * The computer-provider contract.
 *
 * This is the interface product code codes against. It deliberately describes
 * only what a bot needs from a cloud computer: get one, wake it, sleep it, run
 * something in it, move bytes in and out of it, look at its screen, and find out
 * what it is doing. Nothing here names a provider.
 *
 * Design notes that came out of the Instabox spike are marked MEASURED or
 * OBSERVED where they justify a shape.
 */

/** Normalised lifecycle state. Every provider's native states map onto these. */
export type ComputerState =
  | 'provisioning' // being created; no id usable yet
  | 'starting' // booting, waking or resuming; not yet usable
  | 'running' // usable: exec, files and screen work
  | 'sleeping' // paused: disk and (provider-dependent) memory kept, not usable until start()
  | 'stopped' // shut down: disk kept, nothing preserved in memory
  | 'error' // the provider reports a failed lifecycle operation
  | 'destroyed'; // gone; only the record remains

/** A computer, identified by the provider account that owns it. */
export interface ComputerRef {
  readonly provider: string;
  /** Pool account key, e.g. "instabox:acct-1". Allocation and capacity are per account. */
  readonly account: string;
  readonly id: string;
}

export interface ProvisionOptions {
  /** Provider template/image the computer starts from. */
  template?: string;
  /** Size to ask for. Providers may refuse sizes a plan does not offer. */
  size?: { vcpus: number; memMiB: number };
  /** Idle seconds before the provider itself pauses the computer. */
  idleTimeoutSeconds?: number;
  /** Hard backstop: the provider deletes the computer this many seconds after creation. */
  ttlSeconds?: number;
  /** Provider-side labels, so a box can be found again after a crash. */
  metadata?: Record<string, string>;
  /** Give up (and clean up) after this long. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What a computer currently is. Cheap enough to poll; call it before every use. */
export interface ComputerStatus {
  state: ComputerState;
  /** The provider's own state string, for logs and support tickets. */
  raw: string;
  /** True only when exec/files screen are expected to work right now. */
  ready: boolean;
  /** After a wake: false means the paused processes could not be brought back. */
  processesPreserved?: boolean;
  /** Effective idle-pause setting in seconds; null when the provider has it off. */
  idleTimeoutSeconds?: number | null;
  /** Provider-side hard cap on one continuous run, in minutes; null when unlimited. */
  maxRunMinutes?: number | null;
  /** When the provider last paused it by itself (idle, memory pressure, ...). */
  autoSleptAt?: string | null;
  createdAt?: string;
  /** The provider's last failure on this computer, if it is in a failed state. */
  error?: { providerCode: string; message: string };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the command after this many seconds. Providers cap it and may kill sooner. */
  timeoutSeconds?: number;
  /** Stream chunks as they arrive. Without it the call returns at exit. */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** stdout or stderr was cut at the provider's cap. */
  truncated: boolean;
  /** A non-zero exit is still a result, not a thrown error. */
  signal?: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: string;
  modifiedAt: string;
  target?: string;
}

export interface Screenshot {
  png: Uint8Array;
  takenAt: string;
}

export interface ActivityLease {
  id: string;
  expiresAt: string;
}

/**
 * Every provider failure is one of these. Product code branches on `code`,
 * never on a provider's message.
 */
export type ProviderErrorCode =
  | 'auth' // bad or missing credentials for this account
  | 'not_found' // the computer does not exist (any more)
  | 'not_running' // needs start() first; the provider refused a running-only call
  | 'busy' // a lifecycle operation is in flight; retry once it settles
  | 'no_capacity' // no host has room right now: retry with backoff, or try another account
  | 'quota' // this account is at its plan's limit of computers
  | 'rate_limited'
  | 'template_refused' // the account's plan cannot create from that template/size
  | 'timeout'
  | 'unavailable' // provider-side outage or unreachable host
  | 'bad_request'
  | 'unknown';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly providerCode?: string;
  readonly status?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    extra: { retryable?: boolean; retryAfterSeconds?: number; providerCode?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = extra.retryable ?? (code === 'no_capacity' || code === 'rate_limited' || code === 'unavailable');
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.providerCode = extra.providerCode;
    this.status = extra.status;
  }
}

/**
 * What a provider must implement.
 *
 * Contract obligations that the spike proved the hard way:
 *
 * - `provision` resolves only when the computer is `running` and `ready`, so a
 *   caller never receives a box that cannot yet exec. MEASURED: Instabox's
 *   create operation succeeding is not the same as ready.
 * - `start` is idempotent and must be safe to call on a running computer, and
 *   on one that a provider just paused underneath the caller.
 * - `start` resolves only when a subsequent exec will succeed. Callers rely on
 *   "await start(); await exec(...)" with no retry loop of their own.
 * - `sleep` resolves once the computer is no longer usable and no longer
 *   costing runtime; calling it on a sleeping or stopped computer is a no-op.
 * - `destroy` resolves once the computer is gone, and never throws `not_found`
 *   for one that was already gone.
 * - Every method throws `ProviderError` and nothing else.
 */
export interface ComputerProvider {
  readonly name: string;
  readonly account: string;

  provision(options?: ProvisionOptions): Promise<ComputerRef>;
  start(ref: ComputerRef, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ComputerStatus>;
  sleep(ref: ComputerRef): Promise<ComputerStatus>;
  destroy(ref: ComputerRef): Promise<void>;

  exec(ref: ComputerRef, command: string, options?: ExecOptions): Promise<ExecResult>;
  putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void>;
  getFile(ref: ComputerRef, path: string): Promise<Uint8Array>;
  list(ref: ComputerRef, path: string): Promise<FileEntry[]>;
  screenshot(ref: ComputerRef): Promise<Screenshot>;
  status(ref: ComputerRef): Promise<ComputerStatus>;

  /** Keep a computer awake for the length of one task, without polling status. */
  lease(ref: ComputerRef, leaseId: string, ttlSeconds?: number): Promise<ActivityLease>;
  releaseLease(ref: ComputerRef, leaseId: string): Promise<void>;

  /** Everything this account owns, for reconciliation after a crash. */
  listComputers(): Promise<Array<ComputerRef & { name: string; status: ComputerStatus }>>;
}
