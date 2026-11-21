import type { EnqueueRun } from "@terabot/api/run-inline";
import type { RunComputer } from "@terabot/agent";
import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createComputerRuntime } from "@terabot/computers";
import type { RunComputerSignature } from "@terabot/computers";
import type { AllocateResult } from "@terabot/computers";

/**
 * Whether this process is the provisioning host. Read from the environment
 * rather than hardcoded so the same build runs as a queue or an inline
 * deployment, exactly like the run path's `RUN_MODE` check.
 *
 * A function, not a module constant: this module is imported by a route and by
 * server actions, so evaluating it at import would run `serverEnv()` on the
 * build machine, which has no secrets to validate.
 */
export function inlineComputers(): boolean {
  return serverEnv().RUN_MODE === "inline";
}

let runtime: ReturnType<typeof createComputerRuntime> | undefined;

/** The runtime, built once per server process, so the allocator and the run seam agree. */
function runtimeFor(): ReturnType<typeof createComputerRuntime> {
  runtime ??= createComputerRuntime({ store: new DrizzleComputerStore() });
  return runtime;
}

/**
 * The allocator, built once per server process.
 *
 * The web app provisions computers on an inline deployment and destroys them on
 * every deployment (deleting a bot, removing an account), so both paths take this
 * one instance. Built through `createComputerRuntime` rather than assembled by
 * hand: the runtime is what arms the provider's own idle pause, and an allocator
 * without it sleeps boxes in the database while they keep running at the provider.
 */
export function runAllocator(): ComputerAllocator {
  return runtimeFor().allocator;
}

/**
 * Provisions a bot on this host. `allocateForBot` is idempotent per bot and takes
 * a per-bot lock; it also provisions from any non-ready state, so `blocked` and a
 * stale `binding` both recover by asking again.
 */
export async function allocateComputerInline(botId: string): Promise<AllocateResult> {
  return runAllocator().allocateForBot(botId);
}

/**
 * Reclaim ownerless boxes before a bot is told the pool is full. Cheap and
 * idempotent, and the daily cron is too infrequent to keep capacity honest on
 * its own.
 */
export async function sweepComputersInline(): Promise<void> {
  await runAllocator().sweepIdle();
}

/**
 * The run seam for an inline deployment. Taken from the same runtime the request
 * path uses, so a run and a settings "connect" see one pool, not two.
 */
export function inlineRunComputer(): RunComputer {
  const computer: RunComputerSignature = runtimeFor().runComputer;
  return { withLease: (botId, fn) => computer(botId, fn) };
}

/**
 * Wraps the run dispatcher so an inline run wakes and leases its computer like a
 * worker run does. A run with no `RunComputer` streams model text but never
 * touches a machine, which is worse than refusing: the reply claims work that
 * did not happen.
 */
export function withComputer(run: EnqueueRun): EnqueueRun {
  const computer = inlineRunComputer();
  return (request) => run({ ...request, computer });
}
