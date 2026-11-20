export type ComputerState =
  | "provisioning"
  | "starting"
  | "running"
  | "sleeping"
  | "stopped"
  | "error"
  | "destroyed";

export interface ComputerRef {
  provider: string;
  account: string;
  id: string;
}

export interface ProvisionOptions {
  template?: string;
  size?: { vcpus: number; memMiB: number };
  idleTimeoutSeconds?: number;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  signal?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt?: string;
}

export interface ComputerStatus {
  state: ComputerState;
  raw?: Record<string, unknown>;
  ready: boolean;
  processesPreserved?: boolean;
  idleTimeoutSeconds?: number;
  maxRunMinutes?: number;
  autoSleptAt?: string | null;
  createdAt?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ActivityLease {
  id: string;
  expiresAt: string;
}

export class ProviderError extends Error {
  readonly code:
    | "no_capacity"
    | "quota"
    | "rate_limited"
    | "template_refused"
    | "not_found"
    | "not_running"
    | "busy"
    | "unavailable"
    | "auth"
    | "timeout"
    | "unknown";
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ProviderError["code"],
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * The provider contract every computer backend implements. Obligations: start
 * is idempotent, sleep on a sleeping box is a no-op, destroy on a missing box
 * resolves, a non-zero exec exit is a result and not an exception, and every
 * method throws ProviderError and nothing else.
 */
export interface ComputerProvider {
  readonly name: string;
  readonly account: string;

  provision(options?: ProvisionOptions): Promise<ComputerRef>;
  start(ref: ComputerRef, options?: { timeoutMs?: number }): Promise<ComputerStatus>;
  sleep(ref: ComputerRef): Promise<ComputerStatus>;
  destroy(ref: ComputerRef): Promise<void>;

  exec(ref: ComputerRef, command: string, options?: ExecOptions): Promise<ExecResult>;
  putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void>;
  getFile(ref: ComputerRef, path: string): Promise<Uint8Array>;
  list(ref: ComputerRef, path: string): Promise<FileEntry[]>;
  screenshot(ref: ComputerRef): Promise<{ png: Uint8Array; takenAt: string }>;
  status(ref: ComputerRef): Promise<ComputerStatus>;

  lease(ref: ComputerRef, leaseId: string, ttlSeconds?: number): Promise<ActivityLease>;
  releaseLease(ref: ComputerRef, leaseId: string): Promise<void>;

  listComputers(): Promise<Array<ComputerRef & { name: string; status: ComputerStatus }>>;
}
