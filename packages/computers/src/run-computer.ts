import type { ComputerProvider } from "./contract.ts";
import { toRef } from "./allocator/types.ts";
import type { ComputerRecord, ProviderFactory } from "./allocator/types.ts";
import { ALLOCATOR_DEFAULTS, ComputerAllocator, asProviderError } from "./allocator/allocator.ts";
import { createProviderFactory } from "./registry.ts";
import type { ProviderRegistryOptions } from "./registry.ts";
import type { ComputerStore } from "./allocator/types.ts";
import type { ComputerFailure } from "./allocator/failures.ts";

/**
 * The machine handle a tool acts on for the length of one lease.
 *
 * Declared structurally, and deliberately not imported from `@terabot/agent`: the
 * harness defines what it needs and this package defines what it can give, and
 * neither has to depend on the other for the two to fit. `packages/agent` checks
 * the fit where the runner is wired in.
 */
export interface MachineHandle {
  readonly computerId: string;
  exec(
    command: string,
    options?: {
      cwd?: string;
      timeoutSeconds?: number;
      onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
      signal?: AbortSignal;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
  }>;
}

export interface MachineExecSummary {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * The obstacle a refused lease produces, structurally the harness's `Obstacle`.
 * `computer_lost` exists only here: the allocator never reports it, because it is
 * the seam that notices a box whose record vanished between allocation and use.
 */
export type RunObstacle = ComputerFailure | {
  code: "computer_lost";
  summary: string;
  detail: string;
  resolution: string;
  userAction: "wait";
  retryable: true;
};

export type LeaseResult<T> =
  | { ok: true; value: T; computerId: string; woke: boolean }
  | { ok: false; obstacle: RunObstacle };

/**
 * The allocator behind the harness's `RunComputer`.
 *
 * One call provides the machine for a whole run's computer use: it provisions or
 * wakes on demand, keeps the box from being swept by the idle reaper while the
 * work runs, and releases the lease in a `finally` so a tool that throws does not
 * leave a box awake forever.
 */
export function createRunComputer(input: {
  allocator: ComputerAllocator;
  providers: ProviderFactory;
}): {
  withLease<T>(botId: string, fn: (machine: MachineHandle) => Promise<T>): Promise<LeaseResult<T>>;
} {
  const { allocator, providers } = input;

  return {
    async withLease<T>(botId: string, fn: (machine: MachineHandle) => Promise<T>): Promise<LeaseResult<T>> {
      const available = await allocator.store.poolAvailabilityFor(botId);
      const ready = await allocator.ensureReady(botId, {}, available);
      if (!ready.ok || !ready.computerId) {
        return { ok: false, obstacle: obstacleFor(ready.failure, ready.reason) };
      }

      const computer = await allocator.store.getComputer(ready.computerId);
      if (!computer) {
        return {
          ok: false,
          obstacle: {
            code: "computer_lost",
            summary: "The computer disappeared before it could be used.",
            detail: "The machine was reported ready, then its record was gone.",
            resolution: "Trying again builds a new one; nothing needs configuring.",
            userAction: "wait",
            retryable: true,
          },
        };
      }

      try {
        const value = await fn(machineFor(allocator, providers, computer));
        return { ok: true, value, computerId: computer.id, woke: ready.woke ?? false };
      } catch (error) {
        /*
         * The machine was ready and then the command failed beneath us — the box
         * was reclaimed, the provider went down, the command timed out. That is
         * still something the bot has to explain, not a stack trace that escapes
         * the tool loop: the model gets an obstacle like any other and answers
         * with it. Cancellation is rethrown, because a stopped run must stop
         * rather than be reported as a computer problem.
         */
        if (isAbort(error)) throw error;
        const providerError = asProviderError(error);
        if (providerError.code === "not_found") {
          await allocator.store.updateComputer(computer.id, { status: "deleted", lastErrorCode: "not_found" });
        }
        return {
          ok: false,
          obstacle: {
            code: "computer_lost",
            summary: "The command could not finish because the computer stopped responding.",
            detail: `${providerError.code}: ${providerError.message}`,
            resolution:
              providerError.code === "timeout"
                ? "Trying again is reasonable; a long command may need to be split or given more time."
                : "Trying again builds or wakes a machine; nothing needs configuring. If it keeps happening, the provider account is worth checking in Settings, under Computer.",
            userAction: "wait",
            retryable: true,
          },
        };
      } finally {
        // Released even when the tool threw: a box held by a dead run never
        // sleeps, which is how a pool runs dry without anyone noticing.
        if (ready.leaseId) {
          await allocator.releaseLease(botId, ready.leaseId).catch(() => undefined);
        }
      }
    },
  };
}

function obstacleFor(failure: ComputerFailure | undefined, reason: string | undefined): RunObstacle {
  if (failure) return failure;
  return {
    code: "provider_error",
    summary: reason ?? "The computer was not available.",
    detail: "The machine could not be brought up for this attempt.",
    resolution: "Trying again in a moment is the fix.",
    userAction: "wait",
    retryable: true,
  };
}

/**
 * One machine, bound to its box and account. Built per lease, so a tool can only
 * reach the computer it was handed and never another bot's.
 */
function machineFor(
  allocator: ComputerAllocator,
  providers: ProviderFactory,
  computer: ComputerRecord,
): MachineHandle {
  let provider: ComputerProvider | undefined;
  return {
    computerId: computer.id,
    async exec(command, options = {}) {
      provider ??= providers(await accountFor(allocator, computer));
      const result = await provider.exec(toRef(computer), command, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    },
  };
}

/** A run that was stopped is a cancellation, never a computer failure. */
function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.message === "aborted")) ||
    (typeof error === "object" && error !== null && (error as { code?: string }).code === "cancelled")
  );
}

async function accountFor(allocator: ComputerAllocator, computer: ComputerRecord) {
  const accounts = await allocator.store.listAccounts();
  const account = accounts.find((entry) => entry.id === computer.accountId);
  if (!account) throw new Error("the account that owns this computer no longer exists");
  return account;
}

/**
 * The runner as a value with the harness's exact generic signature.
 *
 * The harness's `RunComputer` and this package's `MachineHandle` are declared
 * separately so neither package imports the other, and TypeScript cannot infer
 * that `withLease<T>` from a structural handle is the same generic function as
 * the harness's. This makes that comparison in one place, at the seam, so a drift
 * is a type error in the package that owns the runner — instead of a cast in every
 * app that wires it up.
 */
export type RunComputerSignature = <T>(
  botId: string,
  fn: (machine: MachineHandle) => Promise<T>,
) => Promise<LeaseResult<T>>;

export function runComputerWithLease(input: {
  allocator: ComputerAllocator;
  providers: ProviderFactory;
}): RunComputerSignature {
  const runner = createRunComputer(input);
  return (botId, fn) => runner.withLease(botId, fn);
}

/**
 * The one place an allocator and its providers are built together.
 *
 * They share the idle number, and that is the whole reason this exists. The
 * reaper sleeps a box `idleSeconds` after its last use, and the provider is told
 * the same number so it pauses the box by itself if our process dies or never
 * wakes again — two clocks on one figure. Building the pair by hand at each call
 * site is how the provider side got left unarmed before: the allocator slept boxes
 * on its tick while the box itself had no idle pause, so a dead worker meant a box
 * running until its TTL expired.
 */
export function createComputerRuntime(input: {
  store: ComputerStore;
  /** The idle window in seconds: the reaper's, and the provider's own pause. */
  idleSeconds?: number;
  /** Override the provider registry; the tests use this to observe the wiring. */
  providers?: ProviderFactory;
  /** Built from these options when `providers` is not given. Exposed so a test can assert them. */
  providerOptions?: ProviderRegistryOptions;
}): {
  allocator: ComputerAllocator;
  providers: ProviderFactory;
  /** The options the provider registry was built with, which is what arms its idle pause. */
  providerOptions: { idleTimeoutSeconds?: number; ttlSeconds?: number };
  runComputer: RunComputerSignature;
} {
  const idleSeconds = input.idleSeconds ?? ALLOCATOR_DEFAULTS.idleSeconds;
  /*
   * Defaults are merged, never replaced. Calling this with `{ template: "custom" }`
   * used to drop `idleTimeoutSeconds` entirely: the reaper still slept boxes, but
   * the provider was given no pause at all, so a box whose process died ran to its
   * TTL — the exact cost this pairing exists to prevent. Anything the caller sends
   * overrides a default; nothing the caller omits removes one.
   */
  const providerOptions: ProviderRegistryOptions = {
    // Only Instabox takes a provider-side idle pause; the registry passes it to
    // whichever provider implements it and ignores it elsewhere. The same number
    // as the reaper's, so the box pauses itself if our process never wakes again.
    idleTimeoutSeconds: idleSeconds,
    ttlSeconds: ALLOCATOR_DEFAULTS.ttlSeconds,
    ...input.providerOptions,
  };
  const providers = input.providers ?? createProviderFactory(providerOptions);
  const allocator = new ComputerAllocator({
    store: input.store,
    providers,
    config: { idleSeconds },
  });
  return {
    allocator,
    providers,
    providerOptions: {
      ...(providerOptions.idleTimeoutSeconds !== undefined
        ? { idleTimeoutSeconds: providerOptions.idleTimeoutSeconds }
        : {}),
      ...(providerOptions.ttlSeconds !== undefined ? { ttlSeconds: providerOptions.ttlSeconds } : {}),
    },
    runComputer: runComputerWithLease({ allocator, providers }),
  };
}
