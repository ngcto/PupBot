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
    providers: createProviderFactory(),
  });
  return allocator;
}

/**
 * Provisions a bot on this host. The caller has already claimed it, so this does
 * not claim again: `allocateForBot` is idempotent per bot and takes a per-bot
 * lock, which handles everything inside one process.
 */
export async function allocateComputerInline(botId: string): Promise<AllocateResult> {
  return allocatorFor().allocateForBot(botId);
}

/**
 * Take exclusive ownership of a bot's allocation before provisioning it. The
 * allocator's own lock is a per-instance Map and this runtime is several
 * instances, so two requests for one unbound bot could otherwise both create a
 * machine. The claim is an atomic flip to `binding` from any other state, so one
 * instance wins across processes; the loser leaves the work to the winner.
 */
export async function claimComputerInline(botId: string): Promise<boolean> {
  return allocatorFor().store.claimBinding(botId);
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
