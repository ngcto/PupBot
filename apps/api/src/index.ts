import { serve } from "@hono/node-server";
import { serverEnv } from "@terabot/config";
import { loadEnv } from "@terabot/config/load-env";
import { closeDatabase } from "@terabot/db";
import { createApp } from "./app.ts";

loadEnv();

const app = createApp();
const port = serverEnv().API_PORT;

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`terabot api listening on http://localhost:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await closeDatabase();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
