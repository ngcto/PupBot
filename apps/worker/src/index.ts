import { executeRun } from "@pupbot/agent";
import { RUN_QUEUE, closeDatabase, database, startBoss } from "@pupbot/db";
import type { RunJobData } from "@pupbot/db";
import { createGateway } from "@pupbot/providers";
import { registerCatalogJobs } from "./jobs/catalog.ts";

const gateway = createGateway();
const boss = await startBoss();

await boss.work<RunJobData>(RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    const { runId } = job.data;
    try {
      const outcome = await executeRun({ db: database(), gateway, runId, signal: job.signal });
      console.log(`[run ${runId}] ${outcome.status} (${outcome.text.length} chars)`);
    } catch (error) {
      console.error(`[run ${runId}] failed`, error);
      throw error;
    }
  }
});

await registerCatalogJobs(boss);
console.log("pupbot worker listening for runs");

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 5000 });
  await closeDatabase();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
