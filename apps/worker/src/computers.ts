import type { RunComputer } from "@terabot/agent";
import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@terabot/computers";

/**
 * The worker owns the allocator: the run path wakes a bot's computer here, and
 * the maintenance jobs sleep, renew and reconcile. The web app enqueues a
 * provision request but never provisions synchronously.
 */
export function createComputers(): { allocator: ComputerAllocator; runComputer: RunComputer } {
  const env = serverEnv();
  const allocator = new ComputerAllocator({
    store: new DrizzleComputerStore(),
    // A deployment's choice of shape and image is configuration, not product
    // code: the template a provider starts from belongs here, at the one place
    // that builds providers.
    providers: createProviderFactory({
      agent37Template: env.AGENT37_TEMPLATE,
    }),
  });

  const runComputer: RunComputer = {
    ensureReady: (botId) => allocator.ensureReady(botId),
    release: (botId, leaseId) => allocator.releaseLease(botId, leaseId),
  };

  return { allocator, runComputer };
}
