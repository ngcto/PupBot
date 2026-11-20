import { PgBoss } from "pg-boss";
import { serverEnv } from "@pupbot/config";

export const RUN_QUEUE = "run";

/** A bot waiting for a computer: the web action enqueues, the worker provisions. */
export const COMPUTER_PROVISION_QUEUE = "computer-provision";

export interface ComputerProvisionJobData {
  botId: string;
}


export interface RunJobData {
  runId: string;
}

/**
 * The queue is Postgres, so it needs no second service; the API enqueues and
 * the worker consumes. Concurrency is 1 per queue, which is what makes
 * "interrupt then start the next run" deterministic.
 */
export function createBoss(): PgBoss {
  return new PgBoss({
    connectionString: serverEnv().DATABASE_URL,
    schema: "pgboss",
    supervise: false,
    schedule: false,
  });
}

export async function startBoss(): Promise<PgBoss> {
  const boss = createBoss();
  boss.on("error", (error: Error) => console.error("[pg-boss]", error));
  await boss.start();
  await boss.createQueue(RUN_QUEUE);
  return boss;
}
