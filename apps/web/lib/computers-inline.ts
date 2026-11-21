import type { EnqueueRun } from "@terabot/api/run-inline";
import type { RunComputer } from "@terabot/agent";
import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@terabot/computers";
import type { AllocateResult } from "@terabot/computers";

/**
 * Whether this process is the provisioning host. Read from the environment
 * rather than hardcoded so the same build runs as a queue or an inline
 * deployment, exactly like the run path's `RUN_MODE` check.
 */
export const inlineComputers = serverEnv().RUN_MODE === "inline";

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
 * `allocateForBot` is idempotent per bot: it returns an existing ready binding
 * without provisioning again, and takes a per-bot lock so two requests arriving
 * together make one box. A failure is written as `blocked` with a reason, which
 * is what the composer shows instead of a spinner that never resolves.
 */
export async function allocateComputerInline(botId: string): Promise<AllocateResult> {
  return allocatorFor().allocateForBot(botId);
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
