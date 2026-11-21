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
 * Takes exclusive ownership of a bot's allocation before provisioning it, and
 * reports the state that ownership was taken from. The allocator's own lock is a
 * per-instance Map and this runtime is several instances, so two requests for
 * one unbound bot could otherwise both create a machine.
 *
 * Only an unbound bot is claimable: claiming a bound one would move it off
 * `ready`, and the allocator's reuse check keys on that state, so the allocation
 * would build a second box and orphan the first.
 */
export async function claimComputerInline(botId: string): Promise<"claimed" | "ready" | "busy"> {
  const allocator = allocatorFor();
  const binding = await allocator.store.botBinding(botId);
  if (binding?.state === "ready") return "ready";
  if (binding && binding.state !== "unbound") return "busy";
  return (await allocator.store.claimBinding(botId)) ? "claimed" : "busy";
}

export function inlineRunComputer(): RunComputer {
  const computers = allocatorFor();
  return {
    // A bot still waiting on another instance's allocation is told to wait, not
    // allocated again: `ensureReady` provisions whenever the binding is not
    // `ready`, and this runtime is several instances with no shared lock.
    ensureReady: async (botId) => {
      const binding = await computers.store.botBinding(botId);
      if (binding?.state === "binding") {
        return { ok: false, reason: "Your computer is still starting up. Try again in a moment.", blocked: false };
      }
      return computers.ensureReady(botId);
    },
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
