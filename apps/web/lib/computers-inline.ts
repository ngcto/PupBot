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
 * Provisions a bot on this host. `allocateForBot` is idempotent per bot and takes
 * a per-bot lock, but that lock is per process and this runtime is several
 * instances, so the claim is taken through the store first: flipping the bot to
 * `binding` is atomic across instances, and whoever loses the race leaves the
 * work to the winner instead of paying for a second machine.
 */
export async function allocateComputerInline(botId: string): Promise<AllocateResult> {
  const allocator = allocatorFor();
  if (!(await allocator.store.claimBinding(botId))) return { state: "binding" };
  return allocator.allocateForBot(botId);
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
