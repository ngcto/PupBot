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
  readonly bots = new Set<string>();
  readonly bindings = new Map<string, MemoryBinding>();
  readonly leases = new Map<string, LeaseRecord>();
  #counter = 0;

  addBot(botId: string): void {
    this.bots.add(botId);
  }

  addAccount(input: Partial<AccountRecord> & { id: string }): AccountRecord {
    const account: AccountRecord = {
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

  async claimBinding(botId: string): Promise<boolean> {
    if (this.bindings.get(botId)?.state === "binding") return false;
    await this.setBindingState(botId, "binding", null);
    return true;
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
