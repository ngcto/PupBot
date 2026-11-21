import { fileURLToPath } from "node:url";
import { loadEnv } from "@terabot/config/load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.ts";

loadEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const handle = createDatabase(connectionString);
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

await migrate(handle.db, { migrationsFolder: folder });
console.log("migrations applied");
await handle.close();
