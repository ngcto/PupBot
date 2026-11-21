import type { ComputerProvider, ComputerRef, ComputerState } from "../contract.ts";
import type { ComputerFailure, PoolAvailability } from "./failures.ts";

/** A bot's binding state: what the composer and the computer card read. */
export type BindingState = "unbound" | "binding" | "ready" | "blocked";

/** The product-facing status of a box, mapped from the provider's state. */
export type ComputerRowStatus = "provisioning" | "awake" | "asleep" | "waking" | "error" | "deleted";

export interface AccountRecord {
  id: string;
  /** The user who configured this account; null when the deployment provides it. */
  ownerUserId: string | null;
  /** True for a deployment-provided account: exempt from the one-per-provider rule. */
  managed: boolean;
  provider: string;
  label: string;
  /** Encrypted credential; the allocator never decrypts it, the provider factory does. */
  encryptedCredential: string;
  status: "active" | "draining" | "error";
  /**
   * How many boxes this account's plan allows. `0` means unknown: the provider
   * decides, and the allocator never refuses a create on its own count.
   */
  capacity: number;
  /** Set when the provider rate-limits the account: do not start a box before then. */
  parkedUntil: string | null;
  lastError: string | null;
}

export interface ComputerRecord {
  id: string;
  accountId: string | null;
  /** The workspace that owns the box; null once its workspace is deleted. */
  workspaceId: string | null;
  provider: string;
  externalId: string;
  status: ComputerRowStatus;
  metadata: Record<string, string> | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

/** Why a box ended up in the orphan ledger. */
export type OrphanReason = "bot-delete" | "workspace-delete" | "account-delete";

export interface OrphanRecord {
  id: string;
  accountId: string | null;
  provider: string;
  externalId: string;
  reason: OrphanReason;
  botId: string | null;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
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
  /** The bot's workspace, so a workspace delete can find the box. */
  workspaceId?: string | null;
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
  /** The accounts one bot may draw on: its workspace's own, plus deployment pools. */
  /** What this bot's workspace can reach, for wording a block honestly. */
  poolAvailabilityFor(botId: string): Promise<PoolAvailability>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;

  listComputers(): Promise<ComputerRecord[]>;
  getComputer(id: string): Promise<ComputerRecord | null>;
  createComputer(input: CreateComputerInput): Promise<ComputerRecord>;
  updateComputer(id: string, patch: ComputerPatch): Promise<void>;

  botExists(botId: string): Promise<boolean>;
  /** The bot's workspace, recorded on every box it gets. */
  botWorkspaceId(botId: string): Promise<string | null>;
  /** The bot's binding and the box currently linked to it, if any. */
  botBinding(botId: string): Promise<BindingRecord | null>;
  /** The owner of the bot's workspace; null when the bot or its workspace is gone. */
  botOwnerUserId(botId: string): Promise<string | null>;
  setBindingState(botId: string, state: BindingState, reason: string | null): Promise<void>;
  /**
   * Link a box to the bot only if it has no live box, atomically. False means
   * another allocation won the race and the caller must destroy the box it made.
   */
  tryBindComputer(botId: string, computer: ComputerRecord): Promise<boolean>;
  /** Link a box to the bot, releasing the one it had. Also marks the binding ready. */
  bindComputer(botId: string, computer: ComputerRecord): Promise<void>;
  /** Drop the link and leave the bot unbound. */
  releaseComputer(botId: string): Promise<void>;
  /** The bot a box is linked to, for reconcile after a crash. */
  botForComputer(computerId: string): Promise<string | null>;
  /** Bots still "binding" since before this instant: their provision request was lost. */
  staleBindingBotIds(before: string): Promise<string[]>;

  listOrphans(): Promise<OrphanRecord[]>;
  /** Record a box the provider would not delete, with what a later attempt needs. */
  recordOrphan(input: {
    accountId: string | null;
    provider: string;
    externalId: string;
    reason: OrphanReason;
    botId?: string | null;
    lastError: string;
  }): Promise<void>;
  markOrphanAttempt(id: string, error: string | null): Promise<void>;
  deleteOrphan(id: string): Promise<void>;

  listLeases(): Promise<LeaseRecord[]>;
  putLease(lease: LeaseRecord): Promise<void>;
  deleteLease(id: string): Promise<void>;
  deleteLeasesForComputer(computerId: string): Promise<void>;
}

export type ProviderFactory = (account: AccountRecord) => ComputerProvider;

export interface AllocateResult {
  state: "ready" | "blocked";
  computerId?: string;
  /**
   * Why it is blocked. A string for the run record and the UI; `failure` is the
   * structured form the model reads.
   */
  reason?: string;
  /** Present exactly when `state` is "blocked". */
  failure?: ComputerFailure;
}

/**
 * A capability a caller needs from the box it gets. Placement reads
 * `ComputerProvider.capabilities` and refuses an account whose provider cannot
 * deliver it, instead of provisioning a box that will throw the moment the
 * feature is used.
 *
 * `screenshot` is the one that matters today: a provider with no PNG of the
 * screen is not the same product as one that has it, and a bot that needs to
 * look at its screen must not be given a box that cannot show one.
 */
export type RequiredCapability = "exec" | "files" | "screenshot";

/**
 * What a bot's computer must be able to do when the caller does not say.
 *
 * Nothing: a box that cannot screenshot can still run commands and move files,
 * so it is a real computer for a bot that never looks. Refusing it by default
 * would take a working provider out of the pool for every bot — the opposite of
 * allocating across every provider so one being out of capacity does not stop
 * a bot.
 *
 * Strictness belongs to the caller, which is the only place that knows whether
 * the run's tools can look at a screen. A run with computer-use tools passes
 * `["screenshot"]`; one that only shells out passes nothing.
 */
export const DEFAULT_REQUIREMENTS: readonly RequiredCapability[] = [];

export interface AllocateOptions {
  /**
   * Capabilities the box must have. Absent means `DEFAULT_REQUIREMENTS`, which
   * is empty — any provider is acceptable. A caller whose run includes a tool
   * that reads the screen passes `["screenshot"]`, and is then placed only on a
   * provider that has one, or blocked with a reason naming the gap.
   *
   * This lives on the placement call rather than in the run loop so the rule is
   * enforced where the choice of account is made: the run path only has to pass
   * what its tool layer already knows, and nothing else changes.
   */
  requires?: readonly RequiredCapability[];
}

export interface EnsureReadyOptions {
  /** Reuse a lease id; absent, the allocator mints one per run. */
  leaseId?: string;
  timeoutMs?: number;
  /**
   * Capabilities this run needs. Absent means `DEFAULT_REQUIREMENTS`, which is
   * empty. A run whose tools read the screen passes `["screenshot"]`, and it is
   * then checked against a box the bot already has, so a bot bound before the
   * requirement existed fails with a reason naming the gap rather than at the
   * first screenshot call.
   */
  requires?: readonly RequiredCapability[];
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
  /** The structured failure the model relays. Present when `ok` is false. */
  failure?: ComputerFailure;
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
