import { executeRun } from "@pupbot/agent";
import { loadEnv } from "@pupbot/config/load-env";
import { RUN_QUEUE, closeDatabase, database, startBoss } from "@pupbot/db";
import type { RunJobData } from "@pupbot/db";
import { createGateway } from "@pupbot/providers";
import { createComputers } from "./computers.ts";
import { registerCatalogJobs } from "./jobs/catalog.ts";
import { registerComputerJobs } from "./jobs/computers.ts";

loadEnv();

const gateway = createGateway();
const boss = await startBoss();
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
      throw error;
    }
  }
});

await registerCatalogJobs(boss);
await registerComputerJobs(boss, allocator);
console.log("pupbot worker listening for runs");

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
