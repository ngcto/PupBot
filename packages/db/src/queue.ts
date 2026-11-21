import { PgBoss } from "pg-boss";
import { serverEnv } from "@terabot/config";

export const RUN_QUEUE = "run";

/** A bot waiting for a computer: the web action enqueues, the worker provisions. */
export const COMPUTER_PROVISION_QUEUE = "computer-provision";

export interface ComputerProvisionJobData {
  botId: string;
}


export interface RunJobData {
  runId: string;
  /**
   * The account the run belongs to, so the worker can apply the billing gate
   * without re-reading the workspace chain. Carried on the job because the
   * worker has no request to scope from.
   */
  userId?: string;
}

export interface BossOptions {
  /**
   * Run pg-boss maintenance and the cron scheduler in this process. Only the
   * worker does: without it `boss.schedule` never enqueues the idle sweep, lease
   * renewal, reconcile or catalog jobs, and a job orphaned in `active` by a
   * crashed worker is never expired and retried.
   */
  maintain?: boolean;
}

/**
 * The queue is Postgres, so it needs no second service; the API enqueues and
 * the worker consumes. Concurrency is 1 per queue, which is what makes
 * "interrupt then start the next run" deterministic.
 */
export function createBoss(options: BossOptions = {}): PgBoss {
  const maintain = options.maintain ?? false;
  return new PgBoss({
    connectionString: serverEnv().DATABASE_URL,
    schema: "pgboss",
    supervise: maintain,
    schedule: maintain,
  });
}

export async function startBoss(options: BossOptions = {}): Promise<PgBoss> {
  const boss = createBoss(options);
  boss.on("error", (error: Error) => console.error("[pg-boss]", error));
  await boss.start();
  await boss.createQueue(RUN_QUEUE);
  return boss;
}
