import { COMPUTER_PROVISION_QUEUE } from "@pupbot/db";
import type { ComputerProvisionJobData } from "@pupbot/db";
import type { ComputerAllocator } from "@pupbot/computers";
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
    if (sweep.slept || sweep.destroyed || leases.renewed || leases.released || stalled.retried) {
      console.log(
        `[computers] slept=${sweep.slept} destroyed=${sweep.destroyed} renewed=${leases.renewed} ` +
          `released=${leases.released} retried=${stalled.retried} ready=${stalled.ready}`,
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
