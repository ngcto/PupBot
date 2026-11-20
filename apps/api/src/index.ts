import { serve } from "@hono/node-server";
import { serverEnv } from "@pupbot/config";
import { closeDatabase } from "@pupbot/db";
import { createApp } from "./app.ts";

const app = createApp();
const port = serverEnv().API_PORT;

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pupbot api listening on http://localhost:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await closeDatabase();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
