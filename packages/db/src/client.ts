import { serverEnv } from "@terabot/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDatabase(connectionString: string, max = 10): DatabaseHandle {
  const pool = new Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

let shared: DatabaseHandle | undefined;

export function database(): Database {
  return sharedDatabase().db;
}

export function sharedDatabase(): DatabaseHandle {
  if (!shared) shared = createDatabase(serverEnv().DATABASE_URL, serverEnv().DATABASE_POOL_MAX);
  return shared;
}

export async function closeDatabase(): Promise<void> {
  if (!shared) return;
  const handle = shared;
  shared = undefined;
  await handle.close();
}
