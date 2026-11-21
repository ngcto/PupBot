import { COMPUTER_PROVISION_QUEUE } from "@terabot/db";
import type { ComputerProvisionJobData } from "@terabot/db";
import type { ComputerAllocator } from "@terabot/computers";
import type { PgBoss } from "pg-boss";

export const COMPUTER_MAINTENANCE_QUEUE = "computer-maintenance";
export const COMPUTER_RECONCILE_QUEUE = "computer-reconcile";

export async function registerComputerJobs(boss: PgBoss, allocator: ComputerAllocator): Promise<void> {
  await boss.createQueue(COMPUTER_PROVISION_QUEUE);
  await boss.createQueue(COMPUTER_MAINTENANCE_QUEUE);
  await boss.createQueue(COMPUTER_RECONCILE_QUEUE);

  await boss.work<ComputerProvisionJobData>(COMPUTER_PROVISION_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const result = await allocator.allocateForBot(job.data.botId);
      console.log(
        `[computer ${job.data.botId}] ${result.state}${result.reason ? `: ${result.reason}` : ""}`,
      );
    }
  });

  // One tick a minute: idle sweep, lease renewal, and a retry for a provision
  // request whose job died before it ran.
  await boss.schedule(COMPUTER_MAINTENANCE_QUEUE, "* * * * *", null, { retryLimit: 1 });
  await boss.work(COMPUTER_MAINTENANCE_QUEUE, async () => {
    const sweep = await allocator.sweepIdle();
    const leases = await allocator.renewLeases();
    const stalled = await allocator.retryStalledBindings();
    const orphans = await allocator.reapOrphans();
    if (
      sweep.slept ||
      sweep.destroyed ||
      leases.renewed ||
      leases.released ||
      stalled.retried ||
      orphans.reaped ||
      orphans.failed
    ) {
      console.log(
        `[computers] slept=${sweep.slept} destroyed=${sweep.destroyed} renewed=${leases.renewed} ` +
          `released=${leases.released} retried=${stalled.retried} ready=${stalled.ready} ` +
          `orphans_reaped=${orphans.reaped} orphans_failed=${orphans.failed}`,
      );
    }
  });

  await boss.schedule(COMPUTER_RECONCILE_QUEUE, "*/15 * * * *", null, { retryLimit: 1 });
  await boss.work(COMPUTER_RECONCILE_QUEUE, async () => {
    const summary = await allocator.reconcile();
    console.log(
      `[computers] reconcile accounts=${summary.accounts} adopted=${summary.adopted} ` +
        `destroyed=${summary.destroyed} reprovisioned=${summary.reprovisioned} failed=${summary.failed}`,
    );
  });
}
