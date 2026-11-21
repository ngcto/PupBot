import type { RunComputer } from "@terabot/agent";
import { ComputerAllocator, DrizzleComputerStore, createComputerRuntime } from "@terabot/computers";

/**
 * The worker owns the allocator: the run asks this for a machine when a tool needs
 * one, and the maintenance jobs sleep, renew, reconcile and reap. Nothing
 * provisions on a page load or before a model call, so a bot that only chats
 * never costs a box.
 *
 * The seam itself lives in `@terabot/computers` as `createRunComputer`, because
 * the web app implements the identical thing: a deployment on `RUN_MODE=inline`
 * has no worker process at all, so the runs there have to reach the allocator in
 * request. One implementation means the two cannot drift.
 */
export function createComputers(): { allocator: ComputerAllocator; runComputer: RunComputer } {
  // One runtime for the whole process: the providers keep per-account state (the
  // fake's boxes are in this process' memory), so building them per call would
  // hand every exec a provider that has never heard of the box just made. The
  // runtime also arms the provider-side idle pause with the same number the
  // reaper uses.
  const { allocator, runComputer: withLease } = createComputerRuntime({
    store: new DrizzleComputerStore(),
  });
  const runComputer: RunComputer = { withLease };
  return { allocator, runComputer };
}
