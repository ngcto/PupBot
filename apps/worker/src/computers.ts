import type { RunComputer } from "@pupbot/agent";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@pupbot/computers";

/**
 * The worker owns the allocator: the run path wakes a bot's computer here, and
 * the maintenance jobs sleep, renew and reconcile. The web app enqueues a
 * provision request but never provisions synchronously.
 */
export function createComputers(): { allocator: ComputerAllocator; runComputer: RunComputer } {
  const allocator = new ComputerAllocator({
    store: new DrizzleComputerStore(),
    providers: createProviderFactory(),
  });

  const runComputer: RunComputer = {
    ensureReady: (botId) => allocator.ensureReady(botId),
    release: (botId, leaseId) => allocator.releaseLease(botId, leaseId),
  };

  return { allocator, runComputer };
}
