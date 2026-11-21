import { executeRun } from "@terabot/agent";
import { loadEnv } from "@terabot/config/load-env";
import { RUN_QUEUE, closeDatabase, database, startBoss, syncOwnerRolesOnce } from "@terabot/db";
import type { RunJobData } from "@terabot/db";
import { createGateway } from "@terabot/providers";
import { SecretRequestService, VaultService, oneShotSecrets, vaultTools } from "@terabot/vault";
import { createComputers } from "./computers.ts";
import { registerCatalogJobs } from "./jobs/catalog.ts";
import { registerComputerJobs } from "./jobs/computers.ts";

loadEnv();

const gateway = createGateway();

// The Owner is whoever `OWNER_EMAILS` names; reconcile on boot so a changed
// list takes effect without a manual migration run.
await syncOwnerRolesOnce()
  .then((result) =>
    result.disabled
      ? undefined
      : console.log(`[owners] granted=${result.granted} revoked=${result.revoked}`),
  )
  .catch((error: unknown) => console.error("[owners] sync failed", error));
const boss = await startBoss({ maintain: true });
const { allocator, runComputer } = createComputers();

await boss.work<RunJobData>(RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    const { runId, userId } = job.data;
    try {
      // The same vault tools the inline path gets. The ask-the-user card cannot be
      // answered across processes, so this run does not wait for one: the card
      // renders and the answer arrives as the next message. See docs/deploy.md.
      const outcome = await executeRun({
        db: database(),
        gateway,
        runId,
        signal: job.signal,
        computer: runComputer,
        tools: vaultTools({ db: database(), vault: new VaultService(database()), oneShot: oneShotSecrets() }),
        ...(userId ? { userId } : {}),
      });
      console.log(`[run ${runId}] ${outcome.status} (${outcome.text.length} chars)`);
    } catch (error) {
      console.error(`[run ${runId}] failed`, error);
      // A job canceled by shutdown is not a failure to retry: the run is already
      // marked canceled, and a retry would only re-enter the same run.
      if (job.signal.aborted) return;
      throw error;
    } finally {
      // A one-shot value must not outlive the run it was typed for, however it ended.
      await new SecretRequestService(database()).releaseRun({ runId }).catch(() => undefined);
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
