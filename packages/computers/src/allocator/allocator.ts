import { ProviderError } from "../contract.ts";
import type { ComputerProvider, ComputerRef, ComputerStatus, ProviderErrorCode } from "../contract.ts";
import type {
  AccountRecord,
  AllocateResult,
  ComputerRecord,
  ComputerStore,
  EnsureReadyOptions,
  EnsureReadyResult,
  LeaseRecord,
  ProviderFactory,
  ReconcileSummary,
  SweepSummary,
} from "./types.ts";
import { rowStatusFrom, toRef } from "./types.ts";

const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AllocatorConfig {
  /** Sleep a box this many seconds after its last use. */
  idleSeconds: number;
  leaseTtlSeconds: number;
  leaseRenewLeadSeconds: number;
  /** Extra creates on the same account after `no_capacity`. */
  provisionNoCapacityRetries: number;
  /** Total time one allocation may spend waiting between retries. */
  retryBudgetMs: number;
  /** How long one wake may take before the allocator replaces the box. */
  bootTimeoutMs: number;
  /** Provider-side delete deadline, so a crashed allocator leaks for hours only. */
  ttlSeconds: number;
}

export const ALLOCATOR_DEFAULTS: AllocatorConfig = {
  idleSeconds: 600,
  leaseTtlSeconds: 120,
  leaseRenewLeadSeconds: 45,
  provisionNoCapacityRetries: 2,
  retryBudgetMs: 45_000,
  bootTimeoutMs: 90_000,
  ttlSeconds: 3 * 60 * 60,
};

export interface AllocatorOptions {
  store: ComputerStore;
  providers: ProviderFactory;
  config?: Partial<AllocatorConfig>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface ReconcileOptions {
  /** Rebuild boxes the database lost track of instead of only reporting them. */
  reprovision?: boolean;
}

/**
 * The allocator: which account a bot's computer comes from, when it sleeps,
 * what happens when it breaks, and what the product shows when there is
 * nothing to give a bot.
 *
 * The rules it enforces come from the computers spec: `provision` is only
 * retried for `no_capacity` (never after `quota`), `rate_limited` parks an
 * account, `template_refused` and `auth` mark it misconfigured, every lifecycle
 * call for one box is serialised, concurrent wakes share one `start`, and a bot
 * that cannot get a computer is `blocked` with a reason instead of spinning.
 */
export class ComputerAllocator {
  readonly store: ComputerStore;
  readonly config: AllocatorConfig;
  readonly #providers: ProviderFactory;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (message: string) => void;
  readonly #providerCache = new Map<string, ComputerProvider>();
  readonly #botLocks = new Map<string, Promise<unknown>>();
  readonly #boxLocks = new Map<string, Promise<unknown>>();
  readonly #wakes = new Map<string, Promise<WakeOutcome>>();

  constructor(options: AllocatorOptions) {
    this.store = options.store;
    this.#providers = options.providers;
    this.config = { ...ALLOCATOR_DEFAULTS, ...options.config };
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = options.log ?? ((message) => console.log(`[computers] ${message}`));
  }

  /**
   * Give a bot a computer: pick an account, provision, bind. Idempotent per bot
   * under a lock, so two messages arriving together create one box.
   */
  async allocateForBot(botId: string): Promise<AllocateResult> {
    return this.#withBotLock(botId, async () => {
      const current = await this.store.botBinding(botId);
      if (current?.state === "ready" && current.computer && current.computer.status !== "deleted") {
        return { state: "ready", computerId: current.computer.id };
      }

      const accounts = (await this.store.listAccounts()).filter((account) => account.status === "active");
      if (accounts.length === 0) return this.#block(botId, "No computer account is connected.");

      const computers = await this.store.listComputers();
      const hosted = new Set(
        computers.filter((computer) => computer.metadata?.botId === botId).map((computer) => computer.accountId),
      );
      const used = new Map<string, number>();
      for (const computer of computers) {
        if (!computer.accountId || computer.status === "deleted") continue;
        used.set(computer.accountId, (used.get(computer.accountId) ?? 0) + 1);
      }
      const ordered = [...accounts].sort((a, b) => {
        const rank = (account: AccountRecord) => [
          hosted.has(account.id) ? 0 : 1,
          (used.get(account.id) ?? 0) / Math.max(account.capacity, 1),
          account.label,
        ];
        const [hostedA, ratioA, labelA] = rank(a) as [number, number, string];
        const [hostedB, ratioB, labelB] = rank(b) as [number, number, string];
        return hostedA - hostedB || ratioA - ratioB || labelA.localeCompare(labelB);
      });

      await this.store.setBindingState(botId, "binding", null);
      const failures: Array<{ code: ProviderErrorCode; message: string }> = [];

      for (const account of ordered) {
        if (account.parkedUntil && Date.parse(account.parkedUntil) > this.#now().getTime()) {
          failures.push({ code: "rate_limited", message: `parked until ${account.parkedUntil}` });
          continue;
        }
        if ((used.get(account.id) ?? 0) >= account.capacity) {
          failures.push({ code: "quota", message: `${account.label} is at capacity` });
          continue;
        }

        let provider: ComputerProvider;
        try {
          provider = this.#provider(account);
        } catch (error) {
          const providerError = asProviderError(error);
          await this.#markAccountBroken(account, providerError);
          failures.push({ code: providerError.code, message: providerError.message });
          continue;
        }

        const attempt = await this.#provision(account, provider, botId);
        if (!attempt.ok) {
          failures.push({ code: attempt.code, message: attempt.message });
          continue;
        }

        const computer = await this.store.createComputer({
          accountId: account.id,
          provider: provider.name,
          externalId: attempt.ref.id,
          status: "awake",
          metadata: { botId },
          lastUsedAt: this.#now().toISOString(),
        });
        await this.store.bindComputer(botId, computer);
        return { state: "ready", computerId: computer.id };
      }

      return this.#block(botId, describeFailures(failures));
    });
  }

  /**
   * Wake on first use: the run path calls this before the model's first token.
   * `start()` is always explicit; exec never wakes a paused box by itself.
   */
  async ensureReady(botId: string, options: EnsureReadyOptions = {}): Promise<EnsureReadyResult> {
    return this.#ensureReady(botId, options, 0);
  }

  async #ensureReady(botId: string, options: EnsureReadyOptions, depth: number): Promise<EnsureReadyResult> {
    const binding = await this.store.botBinding(botId);
    if (!binding || binding.state !== "ready" || !binding.computer || binding.computer.status === "deleted") {
      const allocation = await this.allocateForBot(botId);
      if (allocation.state !== "ready") {
        return { ok: false, reason: allocation.reason ?? "No computer is available.", blocked: true };
      }
      if (depth >= 2) return { ok: false, reason: "The computer could not be started.", blocked: true };
      return this.#ensureReady(botId, options, depth + 1);
    }

    const computer = binding.computer;
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (!account) {
      await this.store.releaseComputer(botId);
      return { ok: false, reason: "This bot's computer account was removed.", blocked: true };
    }

    let provider: ComputerProvider;
    try {
      provider = this.#provider(account);
    } catch (error) {
      const providerError = asProviderError(error);
      await this.#markAccountBroken(account, providerError);
      return { ok: false, reason: "The computer account's credentials were rejected.", blocked: true };
    }

    let status: ComputerStatus;
    try {
      status = await provider.status(toRef(computer));
    } catch (error) {
      return this.#handleUseError(botId, computer, account, asProviderError(error), options, depth);
    }

    if (status.state === "error" || status.state === "destroyed") {
      return this.#replace(botId, computer, "The computer failed; building a new one.", options, depth);
    }

    let woke = false;
    if (!status.ready) {
      const wake = await this.#wake(computer, provider, options.timeoutMs);
      if (!wake.ok) {
        return this.#handleWakeFailure(botId, computer, account, wake, options, depth);
      }
      woke = true;
    }

    await this.store.updateComputer(computer.id, {
      status: "awake",
      lastUsedAt: this.#now().toISOString(),
      lastError: null,
      lastErrorCode: null,
    });
    if (binding.state !== "ready") await this.store.setBindingState(botId, "ready", null);
    const lease = await this.#takeLease(computer, provider, options.leaseId);
    return { ok: true, computerId: computer.id, woke, ...(lease ? { leaseId: lease.id } : {}) };
  }

  /** Sleep a box now: used when a bot is deleted or its box is not worth keeping. */
  async sleepComputer(computerId: string): Promise<void> {
    const computer = await this.store.getComputer(computerId);
    if (!computer || computer.status === "deleted") return;
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (!account) return;
    const provider = this.#provider(account);
    try {
      await this.#withBoxLock(computer.id, () => provider.sleep(toRef(computer)));
      await this.store.updateComputer(computer.id, { status: "asleep" });
      await this.store.deleteLeasesForComputer(computer.id);
    } catch (error) {
      const providerError = asProviderError(error);
      if (providerError.code === "not_found") {
        await this.store.updateComputer(computer.id, { status: "deleted", lastErrorCode: "not_found" });
        return;
      }
      this.#log(`sleep ${computer.id} failed: ${providerError.code} ${providerError.message}`);
    }
  }

  /** Tear a bot's computer down (bot deleted, or its box is beyond repair). */
  async destroyForBot(botId: string): Promise<void> {
    const binding = await this.store.botBinding(botId);
    const computer = binding?.computer;
    if (computer) await this.#destroyComputer(computer);
    await this.store.releaseComputer(botId);
  }

  /** Sleep every box whose leases have all lapsed and whose idle window is over. */
  async sweepIdle(): Promise<SweepSummary> {
    const nowMs = this.#now().getTime();
    const computers = await this.store.listComputers();
    const leases = await this.store.listLeases();
    const accounts = await this.store.listAccounts();
    let slept = 0;
    let destroyed = 0;

    for (const computer of computers) {
      if (computer.status === "deleted") continue;

      const botId = computer.metadata?.botId;
      if (botId && !(await this.store.botExists(botId))) {
        await this.#destroyComputer(computer);
        destroyed += 1;
        continue;
      }

      if (computer.status !== "awake" && computer.status !== "waking") continue;
      const active = leases.some(
        (lease) => lease.computerId === computer.id && Date.parse(lease.expiresAt) > nowMs,
      );
      if (active) continue;
      const lastUsed = Date.parse(computer.lastUsedAt ?? computer.createdAt);
      if (nowMs - lastUsed < this.config.idleSeconds * 1000) continue;

      const account = accounts.find((entry) => entry.id === computer.accountId);
      if (!account) continue;
      try {
        const provider = this.#provider(account);
        await this.#withBoxLock(computer.id, () => provider.sleep(toRef(computer)));
        await this.store.updateComputer(computer.id, { status: "asleep" });
        await this.store.deleteLeasesForComputer(computer.id);
        slept += 1;
      } catch (error) {
        const providerError = asProviderError(error);
        if (providerError.code === "not_found") {
          await this.store.updateComputer(computer.id, { status: "deleted", lastErrorCode: "not_found" });
        } else {
          this.#log(`idle sleep ${computer.id} failed: ${providerError.code} ${providerError.message}`);
        }
      }
    }
    return { slept, destroyed };
  }

  /** Renew every lease that is about to lapse, so a long model call keeps its box. */
  async renewLeases(): Promise<{ renewed: number; released: number }> {
    const nowMs = this.#now().getTime();
    const leadMs = this.config.leaseRenewLeadSeconds * 1000;
    const leases = await this.store.listLeases();
    const accounts = await this.store.listAccounts();
    let renewed = 0;
    let released = 0;

    for (const lease of leases) {
      const expiresAt = Date.parse(lease.expiresAt);
      if (expiresAt <= nowMs) {
        // The run that held it is gone; letting it lapse is what lets the box sleep.
        await this.store.deleteLease(lease.id);
        released += 1;
        continue;
      }
      if (expiresAt - nowMs > leadMs) continue;
      const computer = await this.store.getComputer(lease.computerId);
      if (!computer || computer.status === "deleted") {
        await this.store.deleteLease(lease.id);
        released += 1;
        continue;
      }
      const account = accounts.find((entry) => entry.id === computer.accountId);
      if (!account) continue;
      try {
        const provider = this.#provider(account);
        const next = await provider.lease(toRef(computer), lease.id, this.config.leaseTtlSeconds);
        await this.store.putLease({ ...lease, expiresAt: next.expiresAt });
        await this.store.updateComputer(computer.id, {
          status: "awake",
          lastUsedAt: this.#now().toISOString(),
        });
        renewed += 1;
      } catch (error) {
        const providerError = asProviderError(error);
        if (providerError.code === "not_running" || providerError.code === "not_found") {
          await this.store.updateComputer(computer.id, {
            status: providerError.code === "not_found" ? "deleted" : "asleep",
          });
          await this.store.deleteLease(lease.id);
          released += 1;
        } else {
          this.#log(`lease ${lease.id} renewal failed: ${providerError.code} ${providerError.message}`);
        }
      }
    }
    return { renewed, released };
  }

  /** Release one run's lease; the sweep sleeps the box once the idle window passes. */
  async releaseLease(botId: string, leaseId: string): Promise<void> {
    if (!LEASE_ID_PATTERN.test(leaseId)) return;
    const binding = await this.store.botBinding(botId);
    const computer = binding?.computer;
    if (computer) {
      const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
      if (account) {
        try {
          await this.#provider(account).releaseLease(toRef(computer), leaseId);
        } catch (error) {
          this.#log(`releaseLease ${leaseId} failed: ${asProviderError(error).code}`);
        }
      }
      await this.store.updateComputer(computer.id, { lastUsedAt: this.#now().toISOString() });
    }
    await this.store.deleteLease(leaseId);
  }

  /**
   * Reconcile on boot: adopt orphans whose bot still exists, destroy strays
   * whose bot is gone, and rebuild boxes the database thinks are alive but the
   * provider does not have.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { accounts: 0, adopted: 0, destroyed: 0, reprovisioned: 0, failed: 0 };
    const accounts = (await this.store.listAccounts()).filter((account) => account.status !== "draining");
    const computers = await this.store.listComputers();

    for (const account of accounts) {
      summary.accounts += 1;
      let provider: ComputerProvider;
      try {
        provider = this.#provider(account);
      } catch (error) {
        await this.#markAccountBroken(account, asProviderError(error));
        summary.failed += 1;
        continue;
      }

      let boxes;
      try {
        boxes = (await provider.listComputers()) as InventoryEntry[];
      } catch (error) {
        this.#log(`reconcile ${account.label}: ${asProviderError(error).code}`);
        summary.failed += 1;
        continue;
      }

      const rows = computers.filter((computer) => computer.accountId === account.id);
      const seen = new Set<string>();

      for (const box of boxes) {
        seen.add(box.id);
        const row = rows.find((computer) => computer.externalId === box.id);
        if (row) {
          const status = rowStatusFrom(box.status.state);
          if (status !== row.status) await this.store.updateComputer(row.id, { status });
          if (status === "deleted") {
            const boundBot = await this.store.botForComputer(row.id);
            if (boundBot) await this.store.releaseComputer(boundBot);
          }
          continue;
        }

        const botId = box.metadata?.botId;
        if (botId && (await this.store.botExists(botId))) {
          const computer = await this.store.createComputer({
            accountId: account.id,
            provider: provider.name,
            externalId: box.id,
            status: rowStatusFrom(box.status.state),
            metadata: box.metadata ?? null,
            lastUsedAt: this.#now().toISOString(),
          });
          const binding = await this.store.botBinding(botId);
          if (!binding?.computer) await this.store.bindComputer(botId, computer);
          summary.adopted += 1;
          continue;
        }

        // A box nobody claims: destroy it rather than let it run forever.
        try {
          await provider.destroy({ provider: provider.name, account: account.id, id: box.id });
          summary.destroyed += 1;
        } catch (error) {
          this.#log(`reconcile destroy ${box.id}: ${asProviderError(error).code}`);
          summary.failed += 1;
        }
      }

      for (const row of rows) {
        if (row.status === "deleted" || seen.has(row.externalId)) continue;
        await this.store.updateComputer(row.id, {
          status: "deleted",
          lastError: "the provider no longer has this computer",
          lastErrorCode: "not_found",
        });
        const botId = await this.store.botForComputer(row.id);
        summary.failed += 1;
        if (!botId) continue;
        await this.store.releaseComputer(botId);
        if (options.reprovision === false) continue;
        const allocation = await this.allocateForBot(botId);
        if (allocation.state === "ready") summary.reprovisioned += 1;
      }
    }

    return summary;
  }

  /**
   * Work a lost provision request again: a bot left "binding" because the job
   * died gets another attempt on the maintenance tick instead of spinning forever.
   */
  async retryStalledBindings(maxAgeSeconds = 120): Promise<{ retried: number; ready: number }> {
    const before = new Date(this.#now().getTime() - maxAgeSeconds * 1000).toISOString();
    const botIds = await this.store.staleBindingBotIds(before);
    let ready = 0;
    for (const botId of botIds) {
      if (!(await this.store.botExists(botId))) continue;
      const result = await this.allocateForBot(botId);
      if (result.state === "ready") ready += 1;
    }
    return { retried: botIds.length, ready };
  }

  /** What the product shows for a bot: the binding state and the box behind it. */
  async bindingForBot(botId: string): Promise<{ state: string; reason: string | null; computer: ComputerRecord | null }> {
    const binding = await this.store.botBinding(botId);
    return {
      state: binding?.state ?? "unbound",
      reason: binding?.reason ?? null,
      computer: binding?.computer ?? null,
    };
  }

  async #provision(
    account: AccountRecord,
    provider: ComputerProvider,
    botId: string,
  ): Promise<{ ok: true; ref: ComputerRef } | { ok: false; code: ProviderErrorCode; message: string }> {
    let waited = 0;
    let noCapacityAttempts = 0;
    let busyRetries = 0;

    while (true) {
      try {
        const ref = await provider.provision({ metadata: { botId }, ttlSeconds: this.config.ttlSeconds });
        return { ok: true, ref };
      } catch (error) {
        const providerError = asProviderError(error);
        switch (providerError.code) {
          case "no_capacity": {
            noCapacityAttempts += 1;
            const waitMs = (providerError.retryAfterSeconds ?? 5) * 1000;
            if (noCapacityAttempts > this.config.provisionNoCapacityRetries || waited + waitMs > this.config.retryBudgetMs) {
              return { ok: false, code: "no_capacity", message: providerError.message };
            }
            waited += waitMs;
            await this.#sleep(waitMs);
            continue;
          }
          case "rate_limited": {
            const seconds = providerError.retryAfterSeconds ?? 60;
            await this.store.updateAccount(account.id, {
              parkedUntil: new Date(this.#now().getTime() + seconds * 1000).toISOString(),
              lastError: providerError.message,
            });
            return { ok: false, code: "rate_limited", message: providerError.message };
          }
          case "quota":
            // Never loop a create on a full account: the API said it cannot help.
            return { ok: false, code: "quota", message: providerError.message };
          case "template_refused":
          case "auth":
            await this.#markAccountBroken(account, providerError);
            return { ok: false, code: providerError.code, message: providerError.message };
          case "busy":
            busyRetries += 1;
            if (busyRetries > 1) return { ok: false, code: "busy", message: providerError.message };
            await this.#sleep(500);
            continue;
          default:
            return { ok: false, code: providerError.code, message: providerError.message };
        }
      }
    }
  }

  async #wake(
    computer: ComputerRecord,
    provider: ComputerProvider,
    timeoutMs: number | undefined,
  ): Promise<WakeOutcome> {
    const inflight = this.#wakes.get(computer.id);
    if (inflight) return inflight;

    const task = (async (): Promise<WakeOutcome> => {
      await this.store.updateComputer(computer.id, { status: "waking" });
      const attempt = () =>
        this.#withBoxLock(computer.id, () =>
          provider.start(toRef(computer), { timeoutMs: timeoutMs ?? this.config.bootTimeoutMs }),
        );

      let lastCode: ProviderErrorCode = "unknown";
      for (let tries = 0; tries < 2; tries += 1) {
        try {
          const status = await attempt();
          if (status.ready) {
            await this.store.updateComputer(computer.id, {
              status: "awake",
              lastUsedAt: this.#now().toISOString(),
              lastError: null,
              lastErrorCode: null,
            });
            return { ok: true };
          }
          lastCode = "timeout";
        } catch (error) {
          const providerError = asProviderError(error);
          lastCode = providerError.code;
          if (providerError.code === "not_found") {
            await this.store.updateComputer(computer.id, { status: "deleted", lastErrorCode: "not_found" });
            return { ok: false, code: "not_found", message: providerError.message };
          }
          if (providerError.code === "auth") return { ok: false, code: "auth", message: providerError.message };
          if (providerError.code !== "busy" && providerError.code !== "timeout" && providerError.code !== "unavailable") {
            return { ok: false, code: providerError.code, message: providerError.message };
          }
          if (providerError.code === "unavailable") {
            await this.store.updateComputer(computer.id, {
              status: "error",
              lastError: providerError.message,
              lastErrorCode: providerError.code,
            });
            return { ok: false, code: "unavailable", message: providerError.message };
          }
        }
      }

      await this.store.updateComputer(computer.id, {
        status: "error",
        lastError: "the computer did not wake",
        lastErrorCode: lastCode,
      });
      return { ok: false, code: lastCode, message: "the computer did not wake" };
    })().finally(() => this.#wakes.delete(computer.id));

    this.#wakes.set(computer.id, task);
    return task;
  }

  async #handleWakeFailure(
    botId: string,
    computer: ComputerRecord,
    _account: AccountRecord,
    wake: Extract<WakeOutcome, { ok: false }>,
    options: EnsureReadyOptions,
    depth: number,
  ): Promise<EnsureReadyResult> {
    if (wake.code === "not_found" || wake.code === "timeout") {
      return this.#replace(
        botId,
        computer,
        wake.code === "not_found"
          ? "The computer disappeared; building a new one."
          : "The computer would not wake; building a new one.",
        options,
        depth,
      );
    }
    if (wake.code === "quota") {
      return { ok: false, reason: "Every computer account is busy right now.", blocked: true };
    }
    if (wake.code === "auth") {
      return { ok: false, reason: "The computer account's credentials were rejected.", blocked: true };
    }
    await this.store.updateComputer(computer.id, { status: "awake" });
    return {
      ok: false,
      reason: "The computer is restarting; try again in a moment.",
      blocked: false,
    };
  }

  async #handleUseError(
    botId: string,
    computer: ComputerRecord,
    account: AccountRecord,
    providerError: ProviderError,
    options: EnsureReadyOptions,
    depth: number,
  ): Promise<EnsureReadyResult> {
    if (providerError.code === "not_found") {
      return this.#replace(botId, computer, "The computer disappeared; building a new one.", options, depth);
    }
    if (providerError.code === "auth") {
      await this.#markAccountBroken(account, providerError);
      return { ok: false, reason: "The computer account's credentials were rejected.", blocked: true };
    }
    if (providerError.code === "timeout" || providerError.code === "unavailable") {
      return { ok: false, reason: "The computer is restarting; try again in a moment.", blocked: false };
    }
    return { ok: false, reason: "The computer could not be reached.", blocked: false };
  }

  async #replace(
    botId: string,
    computer: ComputerRecord,
    reason: string,
    options: EnsureReadyOptions,
    depth: number,
  ): Promise<EnsureReadyResult> {
    if (depth >= 2) return { ok: false, reason, blocked: true };
    await this.#destroyComputer(computer);
    await this.store.releaseComputer(botId);
    const allocation = await this.allocateForBot(botId);
    if (allocation.state !== "ready") {
      return { ok: false, reason: allocation.reason ?? reason, blocked: true };
    }
    return this.#ensureReady(botId, options, depth + 1);
  }

  async #destroyComputer(computer: ComputerRecord): Promise<void> {
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (account) {
      try {
        const provider = this.#provider(account);
        await this.#withBoxLock(computer.id, () => provider.destroy(toRef(computer)));
      } catch (error) {
        this.#log(`destroy ${computer.externalId}: ${asProviderError(error).code}`);
      }
    }
    await this.store.deleteLeasesForComputer(computer.id);
    await this.store.updateComputer(computer.id, { status: "deleted" });
  }

  async #takeLease(
    computer: ComputerRecord,
    provider: ComputerProvider,
    leaseId?: string,
  ): Promise<LeaseRecord | null> {
    const id = leaseId && LEASE_ID_PATTERN.test(leaseId) ? leaseId : `task_${crypto.randomUUID().replace(/-/g, "")}`;
    try {
      const lease = await provider.lease(toRef(computer), id, this.config.leaseTtlSeconds);
      const record: LeaseRecord = { id, computerId: computer.id, expiresAt: lease.expiresAt };
      await this.store.putLease(record);
      return record;
    } catch (error) {
      const providerError = asProviderError(error);
      // A lease guards against idle sleep; failing to take one must not stop a run.
      this.#log(`lease ${id} failed: ${providerError.code} ${providerError.message}`);
      return null;
    }
  }

  async #markAccountBroken(account: AccountRecord, error: ProviderError): Promise<void> {
    await this.store.updateAccount(account.id, { status: "error", lastError: `${error.code}: ${error.message}` });
    this.#providerCache.delete(account.id);
  }

  async #block(botId: string, reason: string): Promise<AllocateResult> {
    await this.store.setBindingState(botId, "blocked", reason);
    return { state: "blocked", reason };
  }

  #provider(account: AccountRecord): ComputerProvider {
    const cached = this.#providerCache.get(account.id);
    if (cached) return cached;
    const provider = this.#providers(account);
    this.#providerCache.set(account.id, provider);
    return provider;
  }

  /** One lifecycle call at a time per box: the provider runs one operation too. */
  async #withBoxLock<T>(boxId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#boxLocks.get(boxId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#boxLocks.set(
      boxId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async #withBotLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#botLocks.get(botId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#botLocks.set(
      botId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

type WakeOutcome = { ok: true } | { ok: false; code: ProviderErrorCode; message: string };

type InventoryEntry = ComputerRef & {
  name: string;
  status: ComputerStatus;
  metadata?: Record<string, string>;
};

export function describeFailures(failures: Array<{ code: ProviderErrorCode; message: string }>): string {
  const codes = new Set(failures.map((failure) => failure.code));
  if (codes.has("auth")) return "The computer account's credentials were rejected.";
  if (codes.has("template_refused")) return "The computer account's plan cannot create this kind of computer.";
  if (codes.has("quota") && codes.has("rate_limited")) return "Every computer account is full or rate-limited right now.";
  if (codes.has("quota")) return "Every computer account is full right now.";
  if (codes.has("no_capacity")) return "There is no capacity for a computer right now.";
  if (codes.has("rate_limited")) return "The computer accounts are rate-limited right now.";
  if (codes.size === 0) return "A computer could not be provisioned.";
  return "A computer could not be provisioned.";
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}
