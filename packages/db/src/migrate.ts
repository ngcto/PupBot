import { fileURLToPath } from "node:url";
import { loadEnv } from "@terabot/config/load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.ts";

loadEnv();

// Migrations take session-level advisory locks, so they run on a direct or
// session-mode connection; the app itself uses the pooled one in DATABASE_URL.
const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const handle = createDatabase(connectionString);
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

await migrate(handle.db, { migrationsFolder: folder });
console.log("migrations applied");
await handle.close();
