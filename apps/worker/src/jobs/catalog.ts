import { database, syncModelCatalog } from "@pupbot/db";
import type { PgBoss } from "pg-boss";

export const CATALOG_SYNC_QUEUE = "models-dev-sync";

export async function registerCatalogJobs(boss: PgBoss): Promise<void> {
  await boss.createQueue(CATALOG_SYNC_QUEUE);
  await boss.schedule(CATALOG_SYNC_QUEUE, "17 3 * * *", null, { tz: "UTC", retryLimit: 2 });
  await boss.work(CATALOG_SYNC_QUEUE, async () => {
    const { total, providers } = await syncModelCatalog(database());
    console.log(`catalog: ${total} models from ${providers} providers`);
  });
}
