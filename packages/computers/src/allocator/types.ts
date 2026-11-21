import type { ComputerProvider, ComputerRef, ComputerState } from "../contract.ts";

/** A bot's binding state: what the composer and the computer card read. */
export type BindingState = "unbound" | "binding" | "ready" | "blocked";

/** The product-facing status of a box, mapped from the provider's state. */
export type ComputerRowStatus = "provisioning" | "awake" | "asleep" | "waking" | "error" | "deleted";

export interface AccountRecord {
  id: string;
  provider: string;
  label: string;
  /** Encrypted credential; the allocator never decrypts it, the provider factory does. */
  encryptedCredential: string;
  status: "active" | "draining" | "error";
  /** How many boxes this account's plan allows. */
  capacity: number;
  /** Set when the provider rate-limits the account: do not start a box before then. */
  parkedUntil: string | null;
  lastError: string | null;
}

export interface ComputerRecord {
  id: string;
  accountId: string | null;
  provider: string;
  externalId: string;
  status: ComputerRowStatus;
  metadata: Record<string, string> | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface BindingRecord {
  botId: string;
  state: BindingState;
  reason: string | null;
  computer: ComputerRecord | null;
}

export interface LeaseRecord {
  id: string;
  computerId: string;
  expiresAt: string;
}

export interface AccountPatch {
  status?: AccountRecord["status"];
  parkedUntil?: string | null;
  lastError?: string | null;
  capacity?: number;
}

export interface ComputerPatch {
  status?: ComputerRowStatus;
  lastUsedAt?: string | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  metadata?: Record<string, string> | null;
}

export interface CreateComputerInput {
  accountId: string;
  provider: string;
  externalId: string;
  status: ComputerRowStatus;
  metadata?: Record<string, string> | null;
  lastUsedAt?: string | null;
}

/**
 * Everything the allocator needs from storage, so the same logic is tested in
 * memory and runs on Postgres.
 */
export interface ComputerStore {
  listAccounts(): Promise<AccountRecord[]>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;

  listComputers(): Promise<ComputerRecord[]>;
  getComputer(id: string): Promise<ComputerRecord | null>;
  createComputer(input: CreateComputerInput): Promise<ComputerRecord>;
  updateComputer(id: string, patch: ComputerPatch): Promise<void>;

  botExists(botId: string): Promise<boolean>;
  /** The bot's binding and the box currently linked to it, if any. */
  botBinding(botId: string): Promise<BindingRecord | null>;
  setBindingState(botId: string, state: BindingState, reason: string | null): Promise<void>;
  /**
   * Take ownership of a bot's allocation, atomic across processes. False means
   * another host is already provisioning it, so this one must not start.
   */
  claimBinding(botId: string): Promise<boolean>;
  /** Link a box to the bot, releasing the one it had. Also marks the binding ready. */
  bindComputer(botId: string, computer: ComputerRecord): Promise<void>;
  /** Drop the link and leave the bot unbound. */
  releaseComputer(botId: string): Promise<void>;
  /** The bot a box is linked to, for reconcile after a crash. */
  botForComputer(computerId: string): Promise<string | null>;
  /** Bots still "binding" since before this instant: their provision request was lost. */
  staleBindingBotIds(before: string): Promise<string[]>;

  listLeases(): Promise<LeaseRecord[]>;
  putLease(lease: LeaseRecord): Promise<void>;
  deleteLease(id: string): Promise<void>;
  deleteLeasesForComputer(computerId: string): Promise<void>;
}

export type ProviderFactory = (account: AccountRecord) => ComputerProvider;

export interface AllocateResult {
  /** `binding`: another host or an earlier request owns this allocation. */
  state: "ready" | "blocked" | "binding";
  computerId?: string;
  reason?: string;
}

export interface EnsureReadyOptions {
  /** Reuse a lease id; absent, the allocator mints one per run. */
  leaseId?: string;
  timeoutMs?: number;
}

export interface EnsureReadyResult {
  ok: boolean;
  computerId?: string;
  leaseId?: string;
  reason?: string;
  /** True when this call actually woke a sleeping box. */
  woke?: boolean;
  /**
   * True when the bot cannot chat until someone acts ("no capacity"), false
   * for a transient failure the UI should retry on the next message.
   */
  blocked?: boolean;
}

export interface ReconcileSummary {
  accounts: number;
  adopted: number;
  destroyed: number;
  reprovisioned: number;
  failed: number;
}

export interface SweepSummary {
  slept: number;
  destroyed: number;
}

/** Normalised state → the row status the product shows. */
export function rowStatusFrom(state: ComputerState): ComputerRowStatus {
  switch (state) {
    case "running":
      return "awake";
    case "sleeping":
    case "stopped":
      return "asleep";
    case "starting":
      return "waking";
    case "provisioning":
      return "provisioning";
    case "error":
      return "error";
    case "destroyed":
      return "deleted";
  }
}

export function toRef(computer: ComputerRecord): ComputerRef {
  return { provider: computer.provider, account: computer.accountId ?? "", id: computer.externalId };
}
