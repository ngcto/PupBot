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
  /** True when the deployment provides this account, false when a user connected it. */
  managed: boolean;
  /**
   * The user who connected an unmanaged account; null on a managed row. The
   * allocator prefers this user's own account over a managed one for their own
   * bots, and never hands one user's account to another user's bot.
   */
  ownerUserId: string | null;
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
  /**
   * The user who owns the bot's workspace, so the allocator can prefer that
   * user's own connected account over a deployment-provided one. Null when the
   * bot or its owner cannot be resolved.
   */
  botOwnerUserId(botId: string): Promise<string | null>;
  /** The bot's binding and the box currently linked to it, if any. */
  botBinding(botId: string): Promise<BindingRecord | null>;
  setBindingState(botId: string, state: BindingState, reason: string | null): Promise<void>;
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
  state: "ready" | "blocked";
  computerId?: string;
  reason?: string;
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
 * What a bot's computer must be able to do unless a caller says otherwise.
 *
 * `screenshot` is the default because of what computer use is: a bot that drives
 * a desktop looks at the screen the same way a person does, so a box with no
 * framebuffer is not a smaller computer, it is the wrong one. A caller that
 * knows its run never needs to look — a shell-only task — passes `requires: []`
 * and is placed on anything.
 */
export const DEFAULT_REQUIREMENTS: readonly RequiredCapability[] = ["screenshot"];

export interface AllocateOptions {
  /**
   * Capabilities the box must have. Absent means `DEFAULT_REQUIREMENTS`, which
   * is `["screenshot"]`; pass `[]` to accept a box that cannot show a screen.
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
   * Capabilities this run needs. Absent means `DEFAULT_REQUIREMENTS`; `[]`
   * accepts a box that cannot show a screen. Checked against a box the bot
   * already has, so a bot bound before the requirement existed fails with a
   * reason naming the gap rather than at the first screenshot call.
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
