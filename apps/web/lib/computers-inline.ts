import type { EnqueueRun } from "@terabot/api/run-inline";
import type { RunComputer } from "@terabot/agent";
import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@terabot/computers";
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

let allocator: ComputerAllocator | undefined;

/**
 * `RUN_MODE=inline`: this process also provisions. The queue is still published
 * to — `apps/worker` drains it on a queue deployment — but here the request does
 * the allocation itself, exactly as `createInlineEnqueue` does for a run.
 */
function allocatorFor(): ComputerAllocator {
  allocator ??= new ComputerAllocator({
    store: new DrizzleComputerStore(),
    providers: createProviderFactory({ agent37Template: serverEnv().AGENT37_TEMPLATE }),
  });
  return allocator;
}

/**
 * Provisions a bot on this host. `allocateForBot` is idempotent per bot and takes
 * a per-bot lock; it also provisions from any non-ready state, so `blocked` and a
 * stale `binding` both recover by asking again.
 */
export async function allocateComputerInline(botId: string): Promise<AllocateResult> {
  return allocatorFor().allocateForBot(botId);
}

/**
 * Reclaim ownerless boxes before a bot is told the pool is full. Cheap and
 * idempotent, and the daily cron is too infrequent to keep capacity honest on
 * its own.
 */
export async function sweepComputersInline(): Promise<void> {
  await allocatorFor().sweepIdle();
}

export function inlineRunComputer(): RunComputer {
  const computers = allocatorFor();
  return {
    ensureReady: (botId) => computers.ensureReady(botId),
    release: (botId, leaseId) => computers.releaseLease(botId, leaseId),
  };
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
