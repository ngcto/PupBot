import { executeRun } from "@terabot/agent";
import { loadEnv } from "@terabot/config/load-env";
import { RUN_QUEUE, closeDatabase, database, startBoss } from "@terabot/db";
import type { RunJobData } from "@terabot/db";
import { createGateway } from "@terabot/providers";
import { createComputers } from "./computers.ts";
import { registerCatalogJobs } from "./jobs/catalog.ts";
import { registerComputerJobs } from "./jobs/computers.ts";

loadEnv();

const gateway = createGateway();
const boss = await startBoss({ maintain: true });
const { allocator, runComputer } = createComputers();

await boss.work<RunJobData>(RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    const { runId } = job.data;
    try {
      const outcome = await executeRun({
        db: database(),
        gateway,
        runId,
        signal: job.signal,
        computer: runComputer,
      });
      console.log(`[run ${runId}] ${outcome.status} (${outcome.text.length} chars)`);
    } catch (error) {
      console.error(`[run ${runId}] failed`, error);
      // A job canceled by shutdown is not a failure to retry: the run is already
      // marked canceled, and a retry would only re-enter the same run.
      if (job.signal.aborted) return;
      throw error;
    }
  }
});

await registerCatalogJobs(boss);
await registerComputerJobs(boss, allocator);
console.log("terabot worker listening for runs");

// Adopt what the last process left behind, without holding up the queue.
void allocator
  .reconcile()
  .then((summary) =>
    console.log(
      `[computers] boot reconcile adopted=${summary.adopted} destroyed=${summary.destroyed} ` +
        `reprovisioned=${summary.reprovisioned} failed=${summary.failed}`,
    ),
  )
  .catch((error: unknown) => console.error("[computers] boot reconcile failed", error));

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 5000 });
  await closeDatabase();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
