import { CredentialConfigError, ProviderError } from "../contract.ts";
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
  // Must exceed the maintenance interval (60 s), or a lease created just after
  // a tick is never inside the renew window and expires on the next one.
  leaseRenewLeadSeconds: 90,
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
  /**
   * Built providers, keyed by account id. The credential is part of the key: a
   * rotated key gets a fresh provider, because a provider holds the key it was
   * built with and a worker that kept the old one would fail every later call
   * even though the row was updated successfully.
   */
  readonly #providerCache = new Map<string, { credential: string; provider: ComputerProvider }>();
  readonly #botLocks = new Map<string, Promise<unknown>>();
  readonly #boxLocks = new Map<string, Promise<unknown>>();
  readonly #accountLocks = new Map<string, Promise<unknown>>();
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

      const ownerUserId = await this.store.botOwnerUserId(botId);
      const accounts = eligibleAccounts(await this.store.listAccounts(), ownerUserId);
      if (accounts.length === 0) {
        return this.#block(
          botId,
          ownerUserId
            ? "No computer is connected for this bot, and this deployment has no managed capacity."
            : "No computer account is connected.",
        );
      }

      const computers = await this.store.listComputers();
      const hosted = new Set(
        computers.filter((computer) => computer.metadata?.botId === botId).map((computer) => computer.accountId),
      );
      const used = new Map<string, number>();
      for (const computer of computers) {
        if (!computer.accountId || computer.status === "deleted") continue;
        used.set(computer.accountId, (used.get(computer.accountId) ?? 0) + 1);
      }
      // Every provider is tried before a bot is told no. The order is: the box
      // the bot already lives on (a wake, not a move), then the user's *own*
      // connected key, then the deployment's managed account, then a legacy row
      // with no recorded owner, then least-full. A managed account is never
      // special-cased ahead of a user's own, and a stub or leftover row never
      // outranks a real deployment computer.
      const ordered = [...accounts].sort((a, b) => {
        const rank = (account: AccountRecord) => [
          hosted.has(account.id) ? 0 : 1,
          accountClass(account, ownerUserId),
          (used.get(account.id) ?? 0) / Math.max(account.capacity, 1),
          account.label,
        ];
        const [hostedA, classA, ratioA, labelA] = rank(a) as [number, number, number, string];
        const [hostedB, classB, ratioB, labelB] = rank(b) as [number, number, number, string];
        return hostedA - hostedB || classA - classB || ratioA - ratioB || labelA.localeCompare(labelB);
      });

      await this.store.setBindingState(botId, "binding", null);
      const failures: Array<{ code: ProviderErrorCode; message: string }> = [];

      for (const account of ordered) {
        const reservation = await this.#reserveAndProvision(account, botId);
        if (reservation.ok) return { state: "ready", computerId: reservation.computerId };
        failures.push({ code: reservation.code, message: reservation.message });
      }

      return this.#block(botId, describeFailures(failures));
    });
  }

  /**
   * Count this account's boxes and provision under one per-account lock. The
   * capacity read above is a snapshot used for ordering; only this count, taken
   * with no other allocation in flight for the account, can be trusted.
   */
  async #reserveAndProvision(
    account: AccountRecord,
    botId: string,
  ): Promise<{ ok: true; computerId: string } | { ok: false; code: ProviderErrorCode; message: string }> {
    return this.#withAccountLock(account.id, async () => {
      if (account.parkedUntil && Date.parse(account.parkedUntil) > this.#now().getTime()) {
        return { ok: false as const, code: "rate_limited" as const, message: `parked until ${account.parkedUntil}` };
      }
      const computers = await this.store.listComputers();
      const used = computers.filter(
        (computer) => computer.accountId === account.id && computer.status !== "deleted",
      ).length;
      if (used >= account.capacity) {
        return { ok: false as const, code: "quota" as const, message: `${account.label} is at capacity` };
      }

      let provider: ComputerProvider;
      try {
        provider = this.#provider(account);
      } catch (error) {
        const failure = await this.#providerBuildFailure(account, error);
        return { ok: false as const, code: failure.code, message: failure.message };
      }

      const attempt = await this.#provision(account, provider, botId);
      if (!attempt.ok) return attempt;

      let computer: ComputerRecord;
      try {
        computer = await this.store.createComputer({
          accountId: account.id,
          provider: provider.name,
          externalId: attempt.ref.id,
          status: "awake",
          metadata: { [OWNER_TAG]: "1", botId },
          lastUsedAt: this.#now().toISOString(),
        });
      } catch (error) {
        // The account row was removed while the provider was creating, so this
        // insert has no account to hang off. The machine exists and nothing
        // would ever find it by account again, so destroy it here: a failed
        // bookkeeping insert must not leave a box billing.
        await provider.destroy(attempt.ref).catch((next: unknown) => {
          this.#log(`orphaned ${attempt.ref.id} could not be destroyed: ${asProviderError(next).code}`);
        });
        throw error;
      }
      await this.store.bindComputer(botId, computer);
      return { ok: true as const, computerId: computer.id };
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
      const failure = await this.#providerBuildFailure(account, error);
      return {
        ok: false,
        reason:
          failure.code === "auth"
            ? "The computer account's credentials were rejected."
            : "The computer service is misconfigured; try again later.",
        blocked: failure.code === "auth",
      };
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
      const account = accounts.find((entry) => entry.id === computer.accountId);
      if (!account) continue;

      try {
        const provider = this.#provider(account);
        // The lease list and the last-use stamp are read again inside the box
        // lock, and taking a lease happens under the same lock, so a run cannot
        // slip a lease in between this decision and the suspend.
        const sleptThisOne = await this.#withBoxLock(computer.id, async () => {
          const leases = await this.store.listLeases();
          const live = leases.some(
            (lease) => lease.computerId === computer.id && Date.parse(lease.expiresAt) > nowMs,
          );
          if (live) return false;
          const fresh = await this.store.getComputer(computer.id);
          if (!fresh) return false;
          const lastUsed = Date.parse(fresh.lastUsedAt ?? fresh.createdAt);
          if (nowMs - lastUsed < this.config.idleSeconds * 1000) return false;
          await provider.sleep(toRef(computer));
          await this.store.updateComputer(computer.id, { status: "asleep" });
          await this.store.deleteLeasesForComputer(computer.id);
          return true;
        });
        if (sleptThisOne) slept += 1;
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
   *
   * Cleanup is limited to machines this deployment can prove it created. A user
   * may connect their own provider account, and that account's inventory is the
   * user's: their other machines must never be adopted or deleted just because
   * the account joined the pool. The marker is set on every box we provision.
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
        await this.#providerBuildFailure(account, error);
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

      // A successful round trip proves the account works again: nothing else
      // restores a drained account, and an operator fixing the key or the
      // credential should not have to reset rows by hand.
      if (account.status === "error") {
        await this.store.updateAccount(account.id, { status: "active", lastError: null });
      }

      const rows = computers.filter((computer) => computer.accountId === account.id);
      const seen = new Set<string>();

      for (const box of boxes) {
        // Somebody else's machine on a shared account: not ours to touch.
        if (!isOurs(box)) continue;
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
        // Adoption hands a machine to a bot, so the bot's owner must be somebody
        // this account may serve. A user's key is for that user's own bots; a
        // managed account and one with no recorded owner serve anyone. Without
        // this, a bot on a shared key could label a machine with another bot's
        // id and have reconcile bind it across users.
        //
        // An owner that cannot be resolved is allowed through rather than
        // refused: the store says that happens, and refusing would strand every
        // box whose bot row is being created as reconcile runs. The case worth
        // stopping is two *different* known owners.
        const botOwner = botId ? await this.store.botOwnerUserId(botId) : null;
        const wrongOwner =
          account.ownerUserId !== null && !account.managed && botOwner !== null && botOwner !== account.ownerUserId;
        if (wrongOwner) {
          // Not adopted, and not destroyed either. The machine says it belongs
          // to a bot this account may not serve, which on a key two deployments
          // share means it may be somebody else's running work. Leaving it is
          // recoverable; deleting it is not.
          this.#log(`reconcile ${account.label}: ${box.id} is labelled for another owner, leaving it`);
          summary.failed += 1;
          continue;
        }
        if (botId && (await this.store.botExists(botId))) {
          // Adoption books a row against this account, so it has to respect the
          // same capacity the provisioning path does. Without this a reconcile
          // can push an account past its capacity and starve every later bot.
          const booked = (await this.store.listComputers()).filter(
            (computer) => computer.accountId === account.id && computer.status !== "deleted",
          ).length;
          if (booked >= account.capacity) {
            this.#log(`reconcile ${account.label}: over capacity, not adopting ${box.id}`);
            summary.failed += 1;
            continue;
          }
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

      // An account whose inventory came back empty is indistinguishable from one
      // that cannot list its boxes, and deleting every row on that reading
      // destroys a live pool. The provider-side delete deadline is the backstop
      // for a box that is genuinely gone, so an empty listing is skipped.
      if (boxes.length === 0) continue;

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
        const ref = await provider.provision({ metadata: { [OWNER_TAG]: "1", botId }, ttlSeconds: this.config.ttlSeconds });
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
    account: AccountRecord,
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
      await this.#markAccountBroken(account, new ProviderError("auth", wake.message));
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
      // Under the box lock so the idle sweep cannot decide to sleep this box
      // between the provider lease and the row that records it.
      const lease = await this.#withBoxLock(computer.id, () => provider.lease(toRef(computer), id, this.config.leaseTtlSeconds));
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
    this.#log(`account ${account.label} drained: ${error.code}: ${error.message}`);
  }

  /**
   * Turn a provider-build failure into the allocator's own vocabulary. A
   * deployment-wide credential problem is reported but never drains an account;
   * anything else (a key that no longer decrypts, an unknown provider kind) is
   * the account's problem and takes it out of the pool until reconcile proves
   * it works again.
   */
  async #providerBuildFailure(
    account: AccountRecord,
    error: unknown,
  ): Promise<{ code: ProviderErrorCode; message: string }> {
    if (error instanceof CredentialConfigError) {
      this.#log(`account ${account.label} paused until the credential key is fixed: ${error.message}`);
      return { code: "unavailable", message: error.message };
    }
    const providerError = asProviderError(error);
    await this.#markAccountBroken(account, providerError);
    return { code: providerError.code, message: providerError.message };
  }

  async #block(botId: string, reason: string): Promise<AllocateResult> {
    await this.store.setBindingState(botId, "blocked", reason);
    return { state: "blocked", reason };
  }

  #provider(account: AccountRecord): ComputerProvider {
    const cached = this.#providerCache.get(account.id);
    if (cached?.credential === account.encryptedCredential) return cached.provider;
    const provider = this.#providers(account);
    this.#providerCache.set(account.id, { credential: account.encryptedCredential, provider });
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

  /** One capacity count-and-provision at a time per account. */
  async #withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#accountLocks.get(accountId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#accountLocks.set(
      accountId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

type WakeOutcome = { ok: true } | { ok: false; code: ProviderErrorCode; message: string };

/**
 * The metadata key every box we create carries. Reconcile uses it to tell our
 * machines from the ones already sitting on a provider account a user connected:
 * that account's inventory is theirs, and deleting a machine we did not create
 * would be destroying someone's work.
 *
 * It is a metadata label rather than a naming convention so both providers carry
 * it unchanged — Instabox takes `metadata`, Agent37 echoes `metadata` back.
 */
export const OWNER_TAG = "terabot";

/**
 * True when a provider-reported machine was created by this deployment. A box
 * with a `botId` counts too: that id only exists because we minted it.
 */
export function isOurs(box: { metadata?: Record<string, string> | undefined }): boolean {
  return box.metadata?.[OWNER_TAG] === "1" || Boolean(box.metadata?.botId);
}

type InventoryEntry = ComputerRef & {
  name: string;
  status: ComputerStatus;
  metadata?: Record<string, string>;
};

/**
 * Which accounts may serve this bot.
 *
 * A managed account belongs to the deployment, and an account with no recorded
 * owner came from the deployment too (an operator's environment key, a seed, or
 * a row that predates `owner_user_id`) — both are available to everyone. An
 * account a user connected belongs to one person and is never handed to another
 * person's bot: that would spend their key and put their box under someone
 * else's agent.
 */
export function eligibleAccounts(accounts: AccountRecord[], ownerUserId: string | null): AccountRecord[] {
  return accounts.filter(
    (account) =>
      account.status === "active" &&
      (account.managed || account.ownerUserId === null || account.ownerUserId === ownerUserId),
  );
}

/**
 * A tiebreak class for ordering candidate accounts, lower first.
 *
 * `0` is the user's own connected key — it wins for their own bots. `1` is the
 * deployment's managed account, which every bot may use. `2` is a row with no
 * recorded owner: a seed or an operator's environment key, and the reason it
 * sits last is that a development stub lives there, so it must never outrank a
 * real deployment computer.
 */
function accountClass(account: AccountRecord, ownerUserId: string | null): number {
  if (!account.managed && ownerUserId !== null && account.ownerUserId === ownerUserId) return 0;
  if (account.managed) return 1;
  return 2;
}

export function describeFailures(failures: Array<{ code: ProviderErrorCode; message: string }>): string {
  const codes = new Set(failures.map((failure) => failure.code));
  if (codes.has("auth")) return "The computer account's credentials were rejected.";
  if (codes.has("template_refused")) return "The computer account's plan cannot create this kind of computer.";
  if (codes.has("quota") && codes.has("rate_limited")) return "Every computer account is full or rate-limited right now.";
  if (codes.has("quota")) return "Every computer account is full right now.";
  if (codes.has("no_capacity")) return "No managed computer is available right now.";
  if (codes.has("rate_limited")) return "The computer accounts are rate-limited right now.";
  if (codes.size === 0) return "A computer could not be provisioned.";
  return "A computer could not be provisioned.";
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}
