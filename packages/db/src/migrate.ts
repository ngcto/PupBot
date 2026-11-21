import { fileURLToPath } from "node:url";
import { loadEnv } from "@terabot/config/load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.ts";
import { syncOwnerRoles } from "./roles.ts";

loadEnv();

// Migrations take session-level advisory locks, so they run on a direct or
// session-mode connection; the app itself uses the pooled one in DATABASE_URL.
const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const handle = createDatabase(connectionString);
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

await migrate(handle.db, { migrationsFolder: folder });
console.log("migrations applied");

// `OWNER_EMAILS` is the only way an account becomes the Owner. Reconciling it
// here means a deployment establishes its Owner on migrate, before the app
// serves a request, and a changed list takes effect on the next deploy.
const owners = await syncOwnerRoles();
if (owners.disabled) {
  console.log("OWNER_EMAILS is not set: nobody was promoted, nobody was demoted");
} else {
  console.log(`owners synced: granted=${owners.granted} revoked=${owners.revoked}`);
}
await handle.close();
