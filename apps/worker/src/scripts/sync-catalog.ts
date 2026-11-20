import { loadEnv } from "@pupbot/config/load-env";
import { closeDatabase, database, syncModelCatalog } from "@pupbot/db";

loadEnv();

try {
  const { total, providers } = await syncModelCatalog(database());
  console.log(`catalog: ${total} models from ${providers} providers`);
} catch (error) {
  console.error(`catalog sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
