import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Composio Platform's REST API, used by the e2e suite so the whole
 * marketplace flow runs with no live project and no real OAuth grant.
 *
 * It is the network edge, not a mock inside the app: the app runs its real
 * `@pupbot/composio` client against this server, so request shapes, status codes,
 * header auth and connection status transitions are exercised for real. State lives
 * in memory: auth configs, connected accounts, and which toolkit the catalogue has.
 *
 * Control endpoints (outside /api, no key needed):
 *   GET  /_health        readiness for Playwright's webServer
 *   GET  /_state         what the stub has, so a test can assert revocation
 *   POST /_control       { reset, holdNext, brokenMs, toolkits }
 */

export interface StubToolkit {
  slug: string;
  name: string;
  description: string;
  authSchemes: string[];
  managedAuthSchemes: string[];
  categories: string[];
}

export const DEFAULT_TOOLKITS: StubToolkit[] = [
  {
    slug: "gmail",
    name: "Gmail",
    description: "Gmail is Google's email service, with spam protection and powerful search.",
    authSchemes: ["OAUTH2"],
    managedAuthSchemes: ["OAUTH2"],
    categories: ["email"],
  },
  {
    slug: "github",
    name: "GitHub",
    description: "GitHub is where developers build software together.",
    authSchemes: ["OAUTH2"],
    managedAuthSchemes: ["OAUTH2"],
    categories: ["developer tools"],
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Slack is a channel-based messaging platform for teams.",
    authSchemes: ["OAUTH2"],
    managedAuthSchemes: ["OAUTH2"],
    categories: ["collaboration"],
  },
  {
    slug: "perplexityai",
    name: "Perplexity AI",
    description: "Perplexity is an answer engine that searches the web.",
    authSchemes: ["API_KEY"],
    managedAuthSchemes: [],
    categories: ["ai agents"],
  },
  {
    slug: "twitter",
    name: "Twitter",
    description: "Twitter is a social network where people post short messages.",
    authSchemes: ["OAUTH2"],
    managedAuthSchemes: [],
    categories: ["social"],
  },
];

const FAKE_KEY = "e2e-fake-key";

interface StubConnection {
  id: string;
  toolkit: string;
  authConfigId: string;
  status: string;
  hold: boolean;
}

export function createComposioStubServer() {
  let toolkits = [...DEFAULT_TOOLKITS];
  let authConfigs = new Map<string, { id: string; toolkit: string; scheme: string; managed: boolean }>();
  let connections = new Map<string, StubConnection>();
  let holdNext = false;
  let brokenUntil = 0;
  let counter = 0;
  // Composio's ids are unique for the life of a project, and our schema keys
  // connections by that id. A reset clears the stub's memory, so the prefix keeps
  // ids unique across runs instead of colliding with rows a previous run wrote.
  const runId = Math.random().toString(36).slice(2, 8);

  const json = (body: unknown, status = 200) => ({
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const toolkitWire = (toolkit: StubToolkit) => ({
    slug: toolkit.slug,
    name: toolkit.name,
    type: "native",
    app: toolkit.name,
    toolkit_type: "api",
    auth_schemes: toolkit.authSchemes,
    composio_managed_auth_schemes: toolkit.managedAuthSchemes,
    is_local_toolkit: false,
    no_auth: false,
    deprecated: { toolkitId: `t_${toolkit.slug}` },
    meta: {
      description: toolkit.description,
      logo: `https://logos.stub.test/${toolkit.slug}`,
      app_url: null,
      categories: toolkit.categories.map((name) => ({ id: name, name })),
      tools_count: 12,
      triggers_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      version: "20260101_00",
    },
  });

  const connectionWire = (connection: StubConnection) => ({
    id: connection.id,
    status: connection.status,
    alias: connection.toolkit,
    created_at: "2026-11-21T00:00:00Z",
    updated_at: "2026-11-21T00:00:00Z",
    toolkit: { slug: connection.toolkit },
    auth_config: { id: connection.authConfigId },
  });

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (reply: { status: number; body: string; headers: Record<string, string> }) => {
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
    };

    if (url.pathname === "/_health") return send(json({ ok: true }));

    // Where a real connect link would land the browser: a page a person can see, so
    // the suite can prove the app opened the hosted flow rather than a dead URL.
    const consent = url.pathname.match(/^\/_consent\/(.+)$/);
    if (consent) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Consent</title><h1>Consent for ${consent[1]}</h1><p>Stub connect page.</p>`,
      );
      return;
    }
    if (url.pathname === "/_state") {
      return send(
        json({
          authConfigs: authConfigs.size,
          connections: [...connections.values()].map((connection) => ({
            id: connection.id,
            toolkit: connection.toolkit,
            status: connection.status,
          })),
        }),
      );
    }
    if (url.pathname === "/_control" && request.method === "POST") {
      const body = await readBody(request);
      if (body.reset === true) {
        authConfigs = new Map();
        connections = new Map();
        toolkits = [...DEFAULT_TOOLKITS];
        holdNext = false;
        brokenUntil = 0;
      }
      if (body.holdNext === true) holdNext = true;
      if (typeof body.brokenMs === "number") brokenUntil = Date.now() + body.brokenMs;
      if (Array.isArray(body.toolkits)) toolkits = body.toolkits as StubToolkit[];
      return send(json({ ok: true }));
    }

    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    if (!url.pathname.startsWith("/api/v3.1")) {
      return send(json({ error: { message: "not a Composio path" } }, 404));
    }

    if (request.headers["x-api-key"] !== FAKE_KEY) {
      return send(json({ error: { message: "Invalid API key", slug: "APIKey_InvalidAPIKey", status: 401 } }, 401));
    }
    if (Date.now() < brokenUntil) {
      return send(json({ error: { message: "upstream exploded", slug: "InternalServerError" } }, 500));
    }

    if (path === "/toolkits" && request.method === "GET") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const category = url.searchParams.get("category");
      const items = toolkits.filter((toolkit) => {
        const matchesSearch =
          !search ||
          toolkit.name.toLowerCase().includes(search) ||
          toolkit.slug.includes(search) ||
          toolkit.description.toLowerCase().includes(search);
        return matchesSearch && (!category || toolkit.categories.includes(category));
      });
      return send(
        json({
          items: items.map(toolkitWire),
          next_cursor: null,
          total_pages: 1,
          current_page: 1,
          total_items: items.length,
        }),
      );
    }

    const toolkitMatch = path.match(/^\/toolkits\/([^/]+)$/);
    if (toolkitMatch && request.method === "GET") {
      const toolkit = toolkits.find((entry) => entry.slug === toolkitMatch[1]);
      if (!toolkit) return send(json({ error: { message: "Toolkit not found" } }, 404));
      return send(json(toolkitWire(toolkit)));
    }

    if (path === "/auth_configs" && request.method === "GET") {
      const slug = url.searchParams.get("toolkit_slug");
      const items = [...authConfigs.values()].filter((config) => !slug || config.toolkit === slug);
      return send(
        json({
          items: items.map((config) => ({
            id: config.id,
            auth_scheme: config.scheme,
            is_composio_managed: config.managed,
            toolkit: { slug: config.toolkit },
          })),
          next_cursor: null,
        }),
      );
    }

    if (path === "/auth_configs" && request.method === "POST") {
      const body = await readBody(request);
      const slug = (body.toolkit as { slug?: string } | undefined)?.slug ?? "";
      const authConfig = (body.auth_config ?? {}) as { type?: string; authScheme?: string };
      const entry = toolkits.find((candidate) => candidate.slug === slug);
      if (!entry) return send(json({ error: { message: "Toolkit not found" } }, 400));
      const managed = authConfig.type === "use_composio_managed_auth";
      const scheme = authConfig.authScheme ?? entry.authSchemes[0] ?? "OAUTH2";
      const id = `ac_${runId}_${++counter}`;
      authConfigs.set(id, { id, toolkit: slug, scheme, managed });
      return send(
        json({ toolkit: { slug }, auth_config: { id, auth_scheme: scheme, is_composio_managed: managed } }, 201),
      );
    }

    if (path === "/connected_accounts/link" && request.method === "POST") {
      const body = await readBody(request);
      const authConfigId = String(body.auth_config_id ?? "");
      const config = authConfigs.get(authConfigId);
      if (!config) return send(json({ error: { message: "Auth config not found" } }, 404));
      const id = `ca_${runId}_${++counter}`;
      connections.set(id, {
        id,
        toolkit: config.toolkit,
        authConfigId,
        status: "INITIALIZING",
        hold: holdNext,
      });
      holdNext = false;
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return send(
        json(
          {
            link_token: `lk_${id}`,
            redirect_url: `${origin}/_consent/${id}`,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            connected_account_id: id,
          },
          201,
        ),
      );
    }

    if (path === "/connected_accounts" && request.method === "GET") {
      const items = [...connections.values()].map((connection) => {
        if (connection.status === "INITIALIZING" && !connection.hold) connection.status = "ACTIVE";
        return connectionWire(connection);
      });
      return send(json({ items, next_cursor: null }));
    }

    const connectionMatch = path.match(/^\/connected_accounts\/([^/]+)$/);
    if (connectionMatch && request.method === "GET") {
      const connection = connections.get(connectionMatch[1]!);
      if (!connection) return send(json({ error: { message: "Connected account not found" } }, 404));
      // A real consent takes as long as the person needs; the stub flips to ACTIVE on
      // the first read after the user is "done", so the UI's own polling moves it.
      if (connection.status === "INITIALIZING" && !connection.hold) connection.status = "ACTIVE";
      return send(json(connectionWire(connection)));
    }

    if (connectionMatch && request.method === "DELETE") {
      const connection = connections.get(connectionMatch[1]!);
      if (!connection) return send(json({ error: { message: "Connected account not found" } }, 404));
      if (url.searchParams.get("revoke_on_delete") !== "true") {
        return send(json({ error: { message: "revoke_on_delete is required", slug: "InvalidRequest" } }, 400));
      }
      connections.delete(connection.id);
      return send(json({ success: true }));
    }

    return send(json({ error: { message: `no stub route for ${request.method} ${url.pathname}` } }, 404));
  });

  return {
    server,
    listen: (port: number) =>
      new Promise<string>((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const { port: bound } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${bound}`);
        });
      }),
  };
}
