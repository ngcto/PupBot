import { createApp } from "@terabot/api";
import { setRequestOidcToken } from "@terabot/config";
import { Hono } from "hono";
import { after } from "next/server";

// One origin for the app and its API: the session cookie is then first-party,
// there is no cross-site CORS, and a run executes in this same long-lived
// function (Fluid compute, up to 300s on Hobby). `apps/api` still runs on its
// own as a Node server for the queue-worker deployment.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type App = Hono;

let app: App | undefined;

/**
 * Built on the first request, not at import: `createApp` validates the
 * environment and opens the Postgres pool, and a build machine has neither.
 */
function hono(): App {
  app ??= new Hono().route("/api/terabot", createApp());
  return app;
}

type WaitUntil = (promise: Promise<unknown>) => void;

function executionContext(): { waitUntil: WaitUntil; passThroughOnException: () => void } {
  return {
    // Hono reads this through `c.executionCtx`, and the inline run hands its
    // promise to `waitUntil` so the run survives past the POST response.
    waitUntil: (promise) => after(() => promise),
    passThroughOnException: () => {},
  };
}

async function handle(request: Request): Promise<Response> {
  // Vercel hands the project's OIDC token to this invocation; the AI Gateway
  // endpoint authenticates with it, and it rotates hourly.
  setRequestOidcToken(request.headers.get("x-vercel-oidc-token"));
  const context = executionContext();
  return hono().fetch(request, {}, context as never);
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE, handle as PUT, handle as OPTIONS };
