import { CredentialConfigError, ProviderError } from "../contract.ts";
import type { ComputerProvider, ComputerRef, ComputerStatus, ProviderErrorCode } from "../contract.ts";
import type { ComputerFailure, PoolAvailability } from "./failures.ts";
import { NO_POOL, classifyFailure } from "./failures.ts";
import type {
  AccountRecord,
  AllocateResult,
  ComputerRecord,
  ComputerStore,
  EnsureReadyOptions,
  EnsureReadyResult,
  LeaseRecord,
  AllocateOptions,
  OrphanReason,
  ProviderFactory,
  ReconcileSummary,
  RequiredCapability,
  SweepSummary,
} from "./types.ts";
import { DEFAULT_REQUIREMENTS, rowStatusFrom, toRef } from "./types.ts";

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
  readonly #providerCache = new Map<string, ComputerProvider>();
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
   * Give a bot a computer, on its first actual use of one: pick the best
   * account this bot may draw on, provision, bind. Idempotent per bot under a
   * lock, so two messages arriving together create one box, and the bind itself
   * is atomic in the store so two *processes* cannot create two.
   *
   * Every account is tried before giving up: the loop below walks the whole
   * ordered pool and only reports a failure once the last one has refused. That
   * is what makes one provider being full a non-event rather than a failed use.
   */
  async allocateForBot(
    botId: string,
    options: AllocateOptions = {},
    availability: PoolAvailability = NO_POOL,
  ): Promise<AllocateResult> {
    return this.#withBotLock(botId, async () => {
      const requires = options.requires ?? DEFAULT_REQUIREMENTS;
      const current = await this.store.botBinding(botId);
      if (current?.state === "ready" && current.computer && current.computer.status !== "deleted") {
        // A box the bot already has is only reused when it can do the job: moving
        // a running bot is worse than failing, but handing it a box that cannot
        // screenshot and letting the feature throw later is worse still. The old
        // box is destroyed, not just unbound — an unbound box with its bot gone
        // is a bill nobody is looking at.
        const gap = await this.#capabilityGap(current.computer, requires);
        if (!gap) return { state: "ready", computerId: current.computer.id };
        this.#log(`bot ${botId} needs ${gap.capability}; its current box cannot, moving it`);
        await this.#destroyComputer(current.computer);
        await this.store.releaseComputer(botId);
      }

      // Every account this bot may use: its owner's own keys plus the
      // deployment's managed pools, and never another user's.
      const ownerUserId = await this.store.botOwnerUserId(botId);
      const accounts = eligibleAccounts(await this.store.listAccounts(), ownerUserId);

      // Nothing connected: there is no point holding the "binding" state or
      // touching a provider. Report what a person would have to do instead.
      if (accounts.length === 0) {
        return this.#block(botId, { accounts: accounts.length, availability, failures: [] });
      }

      // An account whose provider cannot deliver a required capability is left
      // out entirely, so the allocator tries every remaining provider rather
      // than stopping at the first one that would have failed.
      const usable: AccountRecord[] = [];
      const incapable: Array<{ account: AccountRecord; reason: string }> = [];
      for (const account of accounts) {
        const gap = this.#accountCapabilityGap(account, requires);
        if (gap) incapable.push({ account, reason: gap });
        else usable.push(account);
      }
      if (usable.length === 0) {
        // No account can do the job this bot asked for, which is a different
        // answer from "no account at all": say what is missing, plainly.
        const gap = describeMissingCapabilities(incapable.map((entry) => entry.reason));
        await this.store.setBindingState(botId, "blocked", gap);
        return {
          state: "blocked",
          reason: gap,
          failure: {
            code: "provider_error",
            summary: gap,
            detail: "Every connected provider is missing a capability this request needs.",
            resolution: "The user can connect a different computer provider in Settings, under Computer.",
            userAction: "configure",
            retryable: false,
          },
        };
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
      const ordered = [...usable].sort((a, b) => {
        const rank = (account: AccountRecord) => [
          hosted.has(account.id) ? 0 : 1,
          accountClass(account, ownerUserId),
          (used.get(account.id) ?? 0) / Math.max(account.capacity, 1),
          account.provider,
          account.label,
        ];
        const [hostedA, classA, ratioA, providerA, labelA] = rank(a) as [number, number, number, string, string];
        const [hostedB, classB, ratioB, providerB, labelB] = rank(b) as [number, number, number, string, string];
        return (
          hostedA - hostedB ||
          classA - classB ||
          ratioA - ratioB ||
          providerA.localeCompare(providerB) ||
          labelA.localeCompare(labelB)
        );
      });

      await this.store.setBindingState(botId, "binding", null);
      const failures: Array<{ code: ProviderErrorCode; message: string }> = [];

      for (const account of ordered) {
        const reservation = await this.#reserveAndProvision(account, botId);
        if (reservation.ok) return { state: "ready", computerId: reservation.computerId };
        failures.push({ code: reservation.code, message: reservation.message });
      }

      const everyAccount = await this.store.listAccounts();
      return this.#block(botId, { accounts: everyAccount.length, availability, failures });
    });
  }

  /**
   * The first required capability this account's provider cannot deliver, or
   * null. A provider that cannot be built at all is not reported here: that is
   * a broken credential, which `#reserveAndProvision` already handles by naming
   * the account and leaving the rest of the pool usable.
   */
  #accountCapabilityGap(account: AccountRecord, requires: readonly RequiredCapability[]): string | null {
    if (requires.length === 0) return null;
    let provider: ComputerProvider;
    try {
      provider = this.#provider(account);
    } catch {
      return null;
    }
    const missing = requires.find((capability) => !provider.capabilities[capability]);
    if (!missing) return null;
    // The account's own label, not the provider implementation's name: that is
    // the string Settings shows, so the sentence matches what a person can act on.
    const why = provider.capabilities.unsupported[missing];
    return `${account.label} cannot ${missing}${why ? ` (${why})` : ""}`;
  }

  /** The same check for a box the bot already has, so a move is justified. */
  async #capabilityGap(
    computer: ComputerRecord,
    requires: readonly RequiredCapability[],
  ): Promise<{ capability: RequiredCapability } | null> {
    if (requires.length === 0) return null;
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (!account) return { capability: requires[0]! };
    let provider: ComputerProvider;
    try {
      provider = this.#provider(account);
    } catch {
      return null;
    }
    const missing = requires.find((capability) => !provider.capabilities[capability]);
    return missing ? { capability: missing } : null;
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
      /*
       * A capacity of 0 means "this plan's limit is unknown", and the provider is
       * then the authority: the local count exists to avoid a pointless create and
       * to order accounts, never to be stricter than the plan the user paid for.
       * Storing a guessed 1 for a user-supplied key would permanently cap them at
       * one bot with no way to raise it.
       */
      if (account.capacity > 0 && used >= account.capacity) {
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

      const workspaceId = await this.store.botWorkspaceId(botId);
      const computer = await this.store.createComputer({
        accountId: account.id,
        workspaceId,
        provider: provider.name,
        externalId: attempt.ref.id,
        status: "awake",
        metadata: { botId },
        lastUsedAt: this.#now().toISOString(),
      });

      // The bind, not the lock above, is what makes a second box impossible:
      // the lock only serialises this process, and two runs can be served by two
      // of them. If another allocation already bound a box, this one loses and
      // destroys what it just made rather than leaving it to bill unnoticed.
      const bound = await this.store.tryBindComputer(botId, computer);
      if (!bound) {
        await this.#destroyComputer(computer);
        const winner = await this.store.botBinding(botId);
        if (winner?.computer && winner.computer.status !== "deleted") {
          return { ok: true as const, computerId: winner.computer.id };
        }
        return { ok: false as const, code: "busy" as const, message: "another allocation is in flight" };
      }
      return { ok: true as const, computerId: computer.id };
    });
  }

  /**
   * Wake on first use: the run path calls this when the model asks for the
   * computer. `start()` is always explicit; exec never wakes a paused box by
   * itself. A failure comes back structured, because the model — not a card —
   * is what tells the user about it.
   */
  async ensureReady(
    botId: string,
    options: EnsureReadyOptions = {},
    availability: PoolAvailability = NO_POOL,
  ): Promise<EnsureReadyResult> {
    return this.#ensureReady(botId, options, availability, 0);
  }

  async #ensureReady(
    botId: string,
    options: EnsureReadyOptions,
    availability: PoolAvailability,
    depth: number,
  ): Promise<EnsureReadyResult> {
    const requires = options.requires ?? DEFAULT_REQUIREMENTS;
    const binding = await this.store.botBinding(botId);
    if (!binding || binding.state !== "ready" || !binding.computer || binding.computer.status === "deleted") {
      const allocation = await this.allocateForBot(botId, { requires }, availability);
      if (allocation.state !== "ready") {
        return {
          ok: false,
          reason: allocation.reason ?? "No computer is available.",
          blocked: true,
          ...(allocation.failure ? { failure: allocation.failure } : {}),
        };
      }
      if (depth >= 2) {
        return {
          ok: false,
          reason: "The computer could not be started.",
          blocked: true,
          failure: transientFailure("The computer was created but would not start."),
        };
      }
      return this.#ensureReady(botId, options, availability, depth + 1);
    }

    const computer = binding.computer;
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (!account) {
      await this.store.releaseComputer(botId);
      return {
        ok: false,
        reason: "This bot's computer account was removed.",
        blocked: true,
        failure: {
          code: "provider_error",
          summary: "This bot's computer account was removed, so its machine can no longer be reached.",
          detail: "The account that owned the machine is gone from the workspace.",
          resolution:
            "The user can add a computer provider again in Settings, under Computer; the bot builds itself a new machine on the next attempt.",
          userAction: "configure",
          retryable: false,
        },
      };
    }

    // A requirement added after this box was bound must fail loudly here rather
    // than at the first call that needs the capability. `allocateForBot` moves
    // the bot when it can; this is the path where it could not.
    const gap = await this.#capabilityGap(computer, requires);
    if (gap) {
      return {
        ok: false,
        blocked: true,
        reason: describeMissingCapabilities([`${account.label} cannot ${gap.capability}`]),
      };
    }

    let provider: ComputerProvider;
    try {
      provider = this.#provider(account);
    } catch (error) {
      const failure = await this.#providerBuildFailure(account, error);
      const auth = failure.code === "auth";
      return {
        ok: false,
        reason: auth
          ? "The computer account's credentials were rejected."
          : "The computer service is misconfigured; try again later.",
        blocked: auth,
        failure: {
          code: "provider_error",
          summary: auth
            ? `The ${account.provider} credentials for this workspace were rejected.`
            : "The computer provider is misconfigured on this deployment.",
          detail: failure.message,
          resolution: auth
            ? `The user can replace the ${account.provider} key in Settings, under Computer; a key that was revoked or rotated is the usual cause.`
            : "Nothing the user can change: this is a deployment configuration problem. It is worth telling them the machine is unavailable and to try again later.",
          userAction: auth ? "configure" : "none",
          retryable: !auth,
        },
      };
    }

    let status: ComputerStatus;
    try {
      status = await provider.status(toRef(computer));
    } catch (error) {
      return this.#handleUseError(botId, computer, account, asProviderError(error), options, availability, depth);
    }

    if (status.state === "error" || status.state === "destroyed") {
      return this.#replace(botId, computer, "The computer failed; building a new one.", options, availability, depth);
    }

    let woke = false;
    if (!status.ready) {
      const wake = await this.#wake(computer, provider, options.timeoutMs);
      if (!wake.ok) {
        return this.#handleWakeFailure(botId, computer, account, wake, options, availability, depth);
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

  /**
   * Destroy a box at the provider, and never lose track of one that will not go.
   *
   * A destroy that fails leaves a machine running and billing at the provider.
   * That is the one outcome this code exists to prevent, so a failure is
   * recorded in the orphan ledger with the provider, account and external id a
   * later attempt needs, and the reap retries it. The local row is then marked
   * deleted either way: the binding must not keep pointing at a box nobody can
   * use, and the ledger — not the computer row — is the durable record of the
   * leak.
   */
  async #destroyComputer(computer: ComputerRecord, reason: OrphanReason = "bot-delete"): Promise<void> {
    const account = (await this.store.listAccounts()).find((entry) => entry.id === computer.accountId);
    if (account && computer.externalId) {
      try {
        const provider = this.#provider(account);
        await this.#withBoxLock(computer.id, () => provider.destroy(toRef(computer)));
      } catch (error) {
        const providerError = asProviderError(error);
        // `destroy` resolves for a box that is already gone; a `not_found` here
        // still means the box is not there, so there is nothing left to bill.
        if (providerError.code !== "not_found") {
          await this.store.recordOrphan({
            accountId: account.id,
            provider: computer.provider,
            externalId: computer.externalId,
            reason,
            botId: computer.metadata?.botId ?? null,
            lastError: `${providerError.code}: ${providerError.message}`,
          });
          this.#log(
            `destroy ${computer.provider}/${computer.externalId} failed (${providerError.code}); recorded as an orphan`,
          );
        }
      }
    }
    await this.store.deleteLeasesForComputer(computer.id);
    await this.store.updateComputer(computer.id, { status: "deleted" });
  }

  /**
   * Retry every box a previous destroy could not remove. Runs on the maintenance
   * tick, so a provider outage delays the cleanup instead of losing it, and an
   * operator can read `computer_orphan` to see exactly what is still billing.
   */
  async reapOrphans(limit = 20): Promise<{ reaped: number; failed: number }> {
    const orphans = (await this.store.listOrphans()).slice(0, limit);
    const accounts = await this.store.listAccounts();
    let reaped = 0;
    let failed = 0;

    for (const orphan of orphans) {
      const account = accounts.find((entry) => entry.id === orphan.accountId);
      if (!account) {
        // The account row is gone, so its credential is too: nothing can reach
        // this box again. Leave the row for an operator to delete by hand in
        // the provider's dashboard rather than pretending it was cleaned up.
        await this.store.markOrphanAttempt(orphan.id, "the account that owned this box no longer exists");
        failed += 1;
        continue;
      }
      try {
        const provider = this.#provider(account);
        await provider.destroy({ provider: orphan.provider, account: account.id, id: orphan.externalId });
        await this.store.deleteOrphan(orphan.id);
        reaped += 1;
      } catch (error) {
        const providerError = asProviderError(error);
        if (providerError.code === "not_found") {
          await this.store.deleteOrphan(orphan.id);
          reaped += 1;
          continue;
        }
        await this.store.markOrphanAttempt(orphan.id, `${providerError.code}: ${providerError.message}`);
        failed += 1;
      }
    }
    return { reaped, failed };
  }

  /** Tear a bot's computer down now: the bot was deleted and must not keep billing. */
  async destroyForBot(botId: string): Promise<void> {
    const binding = await this.store.botBinding(botId);
    const computer = binding?.computer;
    if (computer) await this.#destroyComputer(computer, "bot-delete");
    await this.store.releaseComputer(botId);
  }

  /**
   * Tear down every box one account owns, before its credential is thrown away.
   *
   * Removing an account is only safe once nothing is left running on it: the row
   * is the only place its key lives, so deleting it while a box survives makes
   * that box undeletable. This destroys what it can and reports what it could
   * not, and the caller refuses the removal when anything is still outstanding.
   */
  async destroyForAccount(accountId: string): Promise<{ destroyed: number; outstanding: number }> {
    /*
     * Orphans that were already here *before* this call. They are retried below,
     * because removing an account is the moment a person expects the backlog
     * cleared — but an orphan recorded during this pass must not be retried here:
     * the provider just refused, and retrying it immediately would turn a real
     * failure into an apparent success.
     */
    const backlog = (await this.store.listOrphans()).filter((orphan) => orphan.accountId === accountId);

    const computers = (await this.store.listComputers()).filter(
      (computer) => computer.accountId === accountId && computer.status !== "deleted",
    );
    let destroyed = 0;
    for (const computer of computers) {
      await this.#destroyComputer(computer, "account-delete");
      destroyed += 1;
    }
    /*
     * A box the provider refused earlier is already an orphan, and it still needs
     * this account's credential. Retry those too: a removal is the one moment a
     * person expects the backlog cleared, and leaving them for the maintenance
     * sweep would make the refusal look permanent when it was not.
     */
    const stillListed = new Set((await this.store.listOrphans()).map((orphan) => orphan.id));
    const account = (await this.store.listAccounts()).find((entry) => entry.id === accountId);
    for (const orphan of backlog.filter((entry) => stillListed.has(entry.id))) {
      if (!account) {
        // No credential, no way in: leave the row for a human to delete in the
        // provider's dashboard rather than claiming it was cleaned up.
        await this.store.markOrphanAttempt(orphan.id, "the account's credential is already gone");
        continue;
      }
      try {
        const provider = this.#provider(account);
        await provider.destroy({ provider: orphan.provider, account: account.id, id: orphan.externalId });
        await this.store.deleteOrphan(orphan.id);
      } catch (error) {
        const providerError = asProviderError(error);
        if (providerError.code === "not_found") {
          await this.store.deleteOrphan(orphan.id);
          continue;
        }
        await this.store.markOrphanAttempt(orphan.id, `${providerError.code}: ${providerError.message}`);
      }
    }

    const outstanding = (await this.store.listOrphans()).filter(
      (orphan) => orphan.accountId === accountId,
    ).length;
    return { destroyed, outstanding };
  }

  /** Tear down every box a workspace still owns: the workspace was deleted. */
  async destroyForWorkspace(workspaceId: string): Promise<{ destroyed: number; orphans: number }> {
    const computers = (await this.store.listComputers()).filter(
      (computer) => computer.workspaceId === workspaceId && computer.status !== "deleted",
    );
    let destroyed = 0;
    for (const computer of computers) {
      const before = (await this.store.listOrphans()).length;
      await this.#destroyComputer(computer, "workspace-delete");
      if ((await this.store.listOrphans()).length > before) {
        this.#log(`workspace ${workspaceId} left an orphan for ${computer.externalId}`);
      }
      destroyed += 1;
    }
    return { destroyed, orphans: (await this.store.listOrphans()).length };
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
    account: AccountRecord,
    wake: Extract<WakeOutcome, { ok: false }>,
    options: EnsureReadyOptions,
    availability: PoolAvailability,
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
        availability,
        depth,
      );
    }
    if (wake.code === "quota") {
      return {
        ok: false,
        reason: "Every computer account is busy right now.",
        blocked: true,
        failure: classifyFailure({ accounts: 1, availability, failures: [{ code: "quota", message: wake.message }] }),
      };
    }
    if (wake.code === "auth") {
      await this.#markAccountBroken(account, new ProviderError("auth", wake.message));
      return {
        ok: false,
        reason: "The computer account's credentials were rejected.",
        blocked: true,
        failure: {
          code: "provider_error",
          summary: `The ${account.provider} credentials for this workspace were rejected when the machine tried to wake.`,
          detail: wake.message,
          resolution: `The user can replace the ${account.provider} key in Settings, under Computer.`,
          userAction: "configure",
          retryable: false,
        },
      };
    }
    await this.store.updateComputer(computer.id, { status: "awake" });
    return {
      ok: false,
      reason: "The computer is restarting; try again in a moment.",
      blocked: false,
      failure: transientFailure("The machine is restarting and was not ready yet.", true),
    };
  }

  async #handleUseError(
    botId: string,
    computer: ComputerRecord,
    account: AccountRecord,
    providerError: ProviderError,
    options: EnsureReadyOptions,
    availability: PoolAvailability,
    depth: number,
  ): Promise<EnsureReadyResult> {
    if (providerError.code === "not_found") {
      return this.#replace(botId, computer, "The computer disappeared; building a new one.", options, availability, depth);
    }
    if (providerError.code === "auth") {
      await this.#markAccountBroken(account, providerError);
      return {
        ok: false,
        reason: "The computer account's credentials were rejected.",
        blocked: true,
        failure: {
          code: "provider_error",
          summary: `The ${account.provider} credentials for this workspace were rejected.`,
          detail: providerError.message,
          resolution: `The user can replace the ${account.provider} key in Settings, under Computer.`,
          userAction: "configure",
          retryable: false,
        },
      };
    }
    if (providerError.code === "timeout" || providerError.code === "unavailable") {
      return {
        ok: false,
        reason: "The computer is restarting; try again in a moment.",
        blocked: false,
        failure: transientFailure(`${account.provider} could not be reached, so the machine was not used.`, true),
      };
    }
    return {
      ok: false,
      reason: "The computer could not be reached.",
      blocked: false,
      failure: {
        code: "provider_error",
        summary: `The machine could not be reached through ${account.provider}.`,
        detail: `${providerError.code}: ${providerError.message}`,
        resolution:
          "Retrying once is reasonable. If it keeps failing, the user can check the provider key in Settings, under Computer.",
        userAction: "configure",
        retryable: true,
      },
    };
  }

  async #replace(
    botId: string,
    computer: ComputerRecord,
    reason: string,
    options: EnsureReadyOptions,
    availability: PoolAvailability,
    depth: number,
  ): Promise<EnsureReadyResult> {
    if (depth >= 2) {
      return { ok: false, reason, blocked: true, failure: transientFailure(reason) };
    }
    await this.#destroyComputer(computer);
    await this.store.releaseComputer(botId);
    const allocation = await this.allocateForBot(botId, options, availability);
    if (allocation.state !== "ready") {
      return {
        ok: false,
        reason: allocation.reason ?? reason,
        blocked: true,
        ...(allocation.failure ? { failure: allocation.failure } : {}),
      };
    }
    return this.#ensureReady(botId, options, availability, depth + 1);
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

  /**
   * Record that the bot cannot get a computer, with the explanation the model
   * will relay. The `reason` string stays because the run record and the UI read
   * it; `failure` is the structured form that carries what the user can do.
   */
  async #block(botId: string, input: Parameters<typeof classifyFailure>[0]): Promise<AllocateResult> {
    const failure = classifyFailure(input);
    await this.store.setBindingState(botId, "blocked", failure.summary);
    return { state: "blocked", reason: failure.summary, failure };
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

type InventoryEntry = ComputerRef & {
  name: string;
  status: ComputerStatus;
  metadata?: Record<string, string>;
};

/**
 * A failure with no user action: the machine or the provider is momentarily
 * unavailable, and trying again is the whole remedy. Used where a specific
 * provider error has already been turned into a sentence.
 */
function transientFailure(detail: string, retryable = true): ComputerFailure {
  return {
    code: "provider_error",
    summary: "The computer was not available for this attempt.",
    detail,
    resolution: retryable
      ? "Nothing to configure and nothing to buy: trying again in a moment is the fix."
      : "Retrying may not help; the provider's own status is the thing to watch.",
    userAction: retryable ? "wait" : "none",
    retryable,
  };
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}


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
export function accountClass(account: AccountRecord, ownerUserId: string | null): number {
  if (!account.managed && ownerUserId !== null && account.ownerUserId === ownerUserId) return 0;
  if (account.managed) return 1;
  return 2;
}

/**
 * What a person is told when every eligible account's provider lacks something
 * the run needs.
 *
 * This sentence is the whole user-visible value of the capability check: it has
 * to say what is missing and which account, because "no computer is available"
 * sends someone to look at capacity, which is not the problem. It is written in
 * the second person and names the thing they can do about it.
 */
export function describeMissingCapabilities(reasons: string[]): string {
  const detail = reasons.join("; ");
  return reasons.length === 1
    ? `No connected computer can do what this bot needs. ${detail}. Connect one that can, or ask for a task that does not need it.`
    : `None of your connected computers can do what this bot needs. ${detail}. Connect one that can, or ask for a task that does not need it.`;
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
