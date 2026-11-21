import type { PoolAvailability } from "./failures.ts";
import type {
  AccountPatch,
  AccountRecord,
  BindingRecord,
  BindingState,
  ComputerPatch,
  ComputerRecord,
  ComputerStore,
  CreateComputerInput,
  LeaseRecord,
  OrphanReason,
  OrphanRecord,
} from "./types.ts";

interface MemoryBinding {
  botId: string;
  state: BindingState;
  reason: string | null;
  computerId: string | null;
  updatedAt: string;
}

/** The store the allocator tests and the fake-provider development path use. */
export class MemoryComputerStore implements ComputerStore {
  readonly accounts = new Map<string, AccountRecord>();
  readonly computers = new Map<string, ComputerRecord>();
  readonly bots = new Map<string, string>();
  readonly bindings = new Map<string, MemoryBinding>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly orphans = new Map<string, OrphanRecord>();
  #counter = 0;
  #orphanSeq = 0;

  /** Register a bot with the workspace it belongs to. */
  addBot(botId: string, workspaceId = "ws-1"): void {
    this.bots.set(botId, workspaceId);
  }

  addAccount(input: Partial<AccountRecord> & { id: string }): AccountRecord {
    const account: AccountRecord = {
      ownerUserId: null,
      managed: false,
      provider: "fake",
      label: input.id,
      encryptedCredential: "memory",
      status: "active",
      capacity: 5,
      parkedUntil: null,
      lastError: null,
      ...input,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  addComputer(input: Partial<ComputerRecord> & { externalId: string; accountId: string }): ComputerRecord {
    const computer = this.#createRow(input);
    this.computers.set(computer.id, computer);
    return computer;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  async poolAvailabilityFor(botId: string): Promise<PoolAvailability> {
    void botId;
    const workspaceId = this.bots.get(botId);
    return {
      managedPool: [...this.accounts.values()].some(
        (account) => account.managed && account.status === "active",
      ),
      planMissing: workspaceId === "ws-noplan",
    };
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    const account = this.accounts.get(id);
    if (account) Object.assign(account, patch);
  }

  async listComputers(): Promise<ComputerRecord[]> {
    return [...this.computers.values()].map((computer) => ({ ...computer }));
  }

  async getComputer(id: string): Promise<ComputerRecord | null> {
    return this.computers.get(id) ?? null;
  }

  async createComputer(input: CreateComputerInput): Promise<ComputerRecord> {
    const computer = this.#createRow(input);
    this.computers.set(computer.id, computer);
    return computer;
  }

  async updateComputer(id: string, patch: ComputerPatch): Promise<void> {
    const computer = this.computers.get(id);
    if (computer) Object.assign(computer, patch);
  }

  async botExists(botId: string): Promise<boolean> {
    return this.bots.has(botId);
  }

  async botWorkspaceId(botId: string): Promise<string | null> {
    return this.bots.get(botId) ?? null;
  }

  /** Owners are optional in the in-memory store; tests set them when they care. */
  readonly botOwners = new Map<string, string>();

  async botOwnerUserId(botId: string): Promise<string | null> {
    return this.botOwners.get(botId) ?? null;
  }

  async botBinding(botId: string): Promise<BindingRecord | null> {
    const binding = this.bindings.get(botId);
    if (!binding) return null;
    return {
      botId,
      state: binding.state,
      reason: binding.reason,
      computer: binding.computerId ? (this.computers.get(binding.computerId) ?? null) : null,
    };
  }

  async setBindingState(botId: string, state: BindingState, reason: string | null): Promise<void> {
    const binding = this.bindings.get(botId);
    if (binding) {
      binding.state = state;
      binding.reason = reason;
      binding.updatedAt = new Date().toISOString();
      return;
    }
    this.bindings.set(botId, { botId, state, reason, computerId: null, updatedAt: new Date().toISOString() });
  }

  /**
   * Same rule as the Postgres unique index: a bot with a live box cannot be
   * given a second one, and the loser is told so instead of silently winning.
   */
  async tryBindComputer(botId: string, computer: ComputerRecord): Promise<boolean> {
    const existing = this.bindings.get(botId);
    if (existing?.computerId) {
      const held = this.computers.get(existing.computerId);
      if (held && held.status !== "deleted") return false;
    }
    this.bindings.set(botId, {
      botId,
      state: "ready",
      reason: null,
      computerId: computer.id,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async bindComputer(botId: string, computer: ComputerRecord): Promise<void> {
    this.bindings.set(botId, {
      botId,
      state: "ready",
      reason: null,
      computerId: computer.id,
      updatedAt: new Date().toISOString(),
    });
  }

  async releaseComputer(botId: string): Promise<void> {
    const binding = this.bindings.get(botId);
    if (binding) {
      binding.computerId = null;
      binding.state = "unbound";
      binding.reason = null;
    }
  }

  async staleBindingBotIds(before: string): Promise<string[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.state === "binding" && Date.parse(binding.updatedAt) < Date.parse(before))
      .map((binding) => binding.botId);
  }

  async botForComputer(computerId: string): Promise<string | null> {
    for (const binding of this.bindings.values()) {
      if (binding.computerId === computerId) return binding.botId;
    }
    return null;
  }

  async listOrphans(): Promise<OrphanRecord[]> {
    return [...this.orphans.values()].map((orphan) => ({ ...orphan }));
  }

  async recordOrphan(input: {
    accountId: string | null;
    provider: string;
    externalId: string;
    reason: OrphanReason;
    botId?: string | null;
    lastError: string;
  }): Promise<void> {
    // A monotonic counter, not the map size: size shrinks when a row is reaped, so
    // `size + 1` would reuse an existing id and silently overwrite a machine that
    // is still billing. The real store uses a uuid; this keeps the same guarantee.
    const id = `orphan-${++this.#orphanSeq}`;
    this.orphans.set(id, {
      id,
      accountId: input.accountId,
      provider: input.provider,
      externalId: input.externalId,
      reason: input.reason,
      botId: input.botId ?? null,
      attempts: 0,
      lastError: input.lastError,
      lastAttemptAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  async markOrphanAttempt(id: string, error: string | null): Promise<void> {
    const orphan = this.orphans.get(id);
    if (!orphan) return;
    orphan.attempts += 1;
    orphan.lastError = error;
    orphan.lastAttemptAt = new Date().toISOString();
  }

  async deleteOrphan(id: string): Promise<void> {
    this.orphans.delete(id);
  }

  async listLeases(): Promise<LeaseRecord[]> {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  async putLease(lease: LeaseRecord): Promise<void> {
    this.leases.set(lease.id, { ...lease });
  }

  async deleteLease(id: string): Promise<void> {
    this.leases.delete(id);
  }

  async deleteLeasesForComputer(computerId: string): Promise<void> {
    for (const [id, lease] of this.leases) {
      if (lease.computerId === computerId) this.leases.delete(id);
    }
  }

  #createRow(
    input: Partial<Omit<ComputerRecord, "id" | "createdAt">> & { externalId: string },
  ): ComputerRecord {
    this.#counter += 1;
    return {
      id: `computer-${this.#counter}`,
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId ?? null,
      provider: input.provider ?? "fake",
      externalId: input.externalId,
      status: input.status ?? "awake",
      metadata: input.metadata ?? null,
      lastUsedAt: input.lastUsedAt ?? null,
      lastError: input.lastError ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      createdAt: new Date().toISOString(),
    };
  }
}
