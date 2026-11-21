import { serverEnv } from "@terabot/config";
import { auth as betterAuth } from "@terabot/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { devStubRoutes } from "./dev/stub.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { createConversationRoutes } from "./routes/conversations.ts";
import type { EnqueueRun } from "./routes/conversations.ts";
import { mobileRoutes } from "./routes/mobile.ts";
import { runRoutes } from "./routes/runs.ts";
import { vaultRoutes } from "./routes/vault.ts";
import { createInlineEnqueue } from "./run-inline.ts";
import type { AppEnv } from "./types.ts";

export interface AppOptions {
  /** Overrides where a run is handed off; tests pass a no-op. */
  enqueue?: EnqueueRun;
  /** Defaults to RUN_MODE. */
  inline?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const env = serverEnv();
  const app = new Hono<AppEnv>();

  app.use(logger());
  app.use(
    "*",
    cors({
      origin: [env.BETTER_AUTH_URL],
      credentials: true,
      allowHeaders: ["content-type", "last-event-id"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, service: "terabot-api" }));

  // The same better-auth handler the web app mounts, so the API is a complete
  // surface for non-browser clients (and for tests) on one cookie.
  app.on(["GET", "POST"], "/api/auth/*", (c) => betterAuth().handler(c.req.raw));

  app.use("/conversations/*", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });

  app.use("/attachments/*", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });

  app.use("/vault", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });
  app.use("/vault/*", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });
  app.use("/secret-requests/*", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });

  app.use("/runs/*", async (c, next) => {
    const session = await betterAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user);
    await next();
  });

  const inline = options.inline ?? env.RUN_MODE === "inline";
  const enqueue = options.enqueue ?? (inline ? createInlineEnqueue() : undefined);

  app.route("/", createConversationRoutes({ enqueue }));
  app.route("/", runRoutes);
  app.route("/", attachmentRoutes);
  app.route("/", vaultRoutes);
  app.route("/", mobileRoutes);

  // Dev-only OpenAI-compatible endpoint: the whole chat path works with no key.
  if (env.STUB_PROVIDER && env.NODE_ENV !== "production") {
    app.route("/dev/stub", devStubRoutes);
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error("[api]", error);
    return c.json({ error: "internal_error", message: error.message }, 500);
  });

  return app;
}
