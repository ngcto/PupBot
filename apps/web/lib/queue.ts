import { COMPUTER_PROVISION_QUEUE, createBoss } from "@terabot/db";
import type { PgBoss } from "pg-boss";

let bossPromise: Promise<PgBoss> | undefined;

/** One pg-boss connection per server process; it lives as long as the app does. */
function boss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const instance = createBoss();
      instance.on("error", (error: Error) => console.error("[pg-boss]", error));
      await instance.start();
      await instance.createQueue(COMPUTER_PROVISION_QUEUE);
      return instance;
    })().catch((error: unknown) => {
      bossPromise = undefined;
      throw error;
    });
  }
  return bossPromise;
}

export async function enqueueComputerProvision(botId: string): Promise<void> {
  const instance = await boss();
  await instance.send(
    COMPUTER_PROVISION_QUEUE,
    { botId },
    { singletonKey: botId, retryLimit: 2, retryDelay: 5, expireInSeconds: 300 },
  );
}
