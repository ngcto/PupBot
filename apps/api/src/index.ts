import { serve } from "@hono/node-server";
import { serverEnv } from "@pupbot/config";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "pupbot-api" }));

const port = serverEnv().API_PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pupbot api listening on http://localhost:${info.port}`);
});
