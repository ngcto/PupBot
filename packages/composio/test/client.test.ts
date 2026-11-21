import { describe, expect, it, vi } from "vitest";
import {
  ComposioClient,
  ComposioError,
  connectionStateFrom,
  supportFor,
} from "../src/index.ts";
import type { ToolkitSummary } from "../src/index.ts";

const KEY = "test_project_key_not_a_real_one";

type Call = { url: URL; method: string; headers: Record<string, string>; body: string | undefined };

function stubFetch(routes: (call: Call) => { status: number; body?: unknown; raw?: string }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const reply = routes(call);
    return new Response(reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body)), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const client = (routes: (call: Call) => { status: number; body?: unknown; raw?: string }) => {
  const { impl, calls } = stubFetch(routes);
  return {
    calls,
    composio: new ComposioClient({ apiKey: KEY, baseUrl: "https://composio.test/api/v3.1", fetch: impl }),
  };
};

const toolkitWire = (overrides: Record<string, unknown> = {}) => ({
  slug: "gmail",
  name: "Gmail",
  type: "native",
  app: "Gmail",
  toolkit_type: "api",
  auth_schemes: ["OAUTH2"],
  composio_managed_auth_schemes: ["OAUTH2"],
  no_auth: false,
  is_local_toolkit: false,
  deprecated: { toolkitId: "t_1" },
  meta: {
    description: "Gmail is Google's email service",
    logo: "https://logos.composio.dev/api/gmail",
    app_url: "https://mail.google.com",
    categories: [{ id: "email", name: "email" }],
    tools_count: 61,
    triggers_count: 2,
    version: "20261120_00",
  },
  ...overrides,
});

const connectionWire = (overrides: Record<string, unknown> = {}) => ({
  id: "ca_1",
  status: "INITIALIZING",
  alias: "work",
  created_at: "2026-11-21T05:54:00.249Z",
  updated_at: "2026-11-21T05:54:00.249Z",
  toolkit: { slug: "gmail" },
  auth_config: { id: "ac_1" },
  ...overrides,
});

describe("listToolkits", () => {
  it("maps the wire into the product shape and keeps the cursor", async () => {
    const { composio, calls } = client(() => ({
      status: 200,
      body: { items: [toolkitWire()], next_cursor: "Mi0y", total_items: 1842 },
    }));

    const page = await composio.listToolkits({ search: "mail", limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      slug: "gmail",
      name: "Gmail",
      description: "Gmail is Google's email service",
      logoUrl: "https://logos.composio.dev/api/gmail",
      appUrl: "https://mail.google.com",
      categories: ["email"],
      authSchemes: ["OAUTH2"],
      managedAuthSchemes: ["OAUTH2"],
      toolsCount: 61,
      support: "managed",
    });
    expect(page.nextCursor).toBe("Mi0y");

    const url = calls[0]!.url;
    expect(url.pathname).toBe("/api/v3.1/toolkits");
    expect(url.searchParams.get("search")).toBe("mail");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("sort_by")).toBe("usage");
    expect(url.searchParams.get("include_deprecated")).toBe("false");
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
  });

  it("survives rows with no meta or deprecated block", async () => {
    const { composio } = client(() => ({
      status: 200,
      body: { items: [{ slug: "x", name: "X" }], next_cursor: null },
    }));
    const page = await composio.listToolkits();
    expect(page.items[0]).toMatchObject({ slug: "x", description: "", logoUrl: "", categories: [], toolsCount: 0 });
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a response that is not a toolkit list", async () => {
    const { composio } = client(() => ({ status: 200, body: { items: [{ name: "no slug" }] } }));
    await expect(composio.listToolkits()).rejects.toMatchObject({ code: "upstream" });
  });
});

describe("support classification", () => {
  const base: Pick<ToolkitSummary, "authSchemes" | "managedAuthSchemes"> = {
    authSchemes: [],
    managedAuthSchemes: [],
  };

  it("uses managed auth when Composio holds the OAuth app", () => {
    expect(supportFor({ ...base, authSchemes: ["OAUTH2"], managedAuthSchemes: ["OAUTH2"] })).toBe("managed");
  });

  it("falls back to a user-supplied key when the hosted page collects it", () => {
    expect(supportFor({ ...base, authSchemes: ["API_KEY"] })).toBe("user-key");
    expect(supportFor({ ...base, authSchemes: ["OAUTH2", "API_KEY"] })).toBe("user-key");
    expect(supportFor({ ...base, authSchemes: ["BASIC", "OAUTH2"] })).toBe("user-key");
  });

  it("is honest about toolkits this beta cannot connect", () => {
    expect(supportFor({ ...base, authSchemes: ["OAUTH2"] })).toBe("needs-setup");
    expect(supportFor({ ...base, authSchemes: ["S2S_OAUTH2", "OAUTH2"] })).toBe("needs-setup");
    expect(supportFor({ ...base, authSchemes: ["NO_AUTH"] })).toBe("needs-setup");
    expect(supportFor(base)).toBe("needs-setup");
  });
});

describe("ensureAuthConfig", () => {
  it("reuses the project's config for the toolkit instead of creating a second one", async () => {
    const { composio, calls } = client((call) => {
      if (call.url.pathname.endsWith("/auth_configs")) {
        return {
          status: 200,
          body: {
            items: [
              { id: "ac_other", auth_scheme: "API_KEY", is_composio_managed: false, toolkit: { slug: "notion" } },
              { id: "ac_gmail", auth_scheme: "OAUTH2", is_composio_managed: true, toolkit: { slug: "gmail" } },
            ],
            next_cursor: null,
          },
        };
      }
      throw new Error("should not create a config");
    });

    const config = await composio.ensureAuthConfig({
      toolkit: "gmail",
      authSchemes: ["OAUTH2"],
      managedAuthSchemes: ["OAUTH2"],
    });

    expect(config).toEqual({ id: "ac_gmail", toolkit: "gmail", scheme: "OAUTH2", managed: true, userSupplied: false });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls[0]!.url.searchParams.get("toolkit_slug")).toBe("gmail");
  });

  it("creates a managed config with Composio's own credentials", async () => {
    const { composio, calls } = client((call) => {
      if (call.method === "GET") return { status: 200, body: { items: [], next_cursor: null } };
      return {
        status: 201,
        body: {
          toolkit: { slug: "github" },
          auth_config: { id: "ac_gh", auth_scheme: "OAUTH2", is_composio_managed: true },
        },
      };
    });

    const config = await composio.ensureAuthConfig({
      toolkit: "github",
      authSchemes: ["OAUTH2"],
      managedAuthSchemes: ["OAUTH2"],
      name: "GitHub",
    });

    expect(config).toMatchObject({ id: "ac_gh", managed: true, userSupplied: false });
    const created = JSON.parse(calls[1]!.body!);
    expect(calls[1]!.method).toBe("POST");
    expect(created).toEqual({
      toolkit: { slug: "github" },
      auth_config: { type: "use_composio_managed_auth", name: "GitHub", authScheme: "OAUTH2" },
    });
  });

  it("creates an empty-credential config so the hosted page can collect the user's key", async () => {
    const { composio, calls } = client((call) => {
      if (call.method === "GET") return { status: 200, body: { items: [], next_cursor: null } };
      return {
        status: 201,
        body: {
          toolkit: { slug: "perplexityai" },
          auth_config: { id: "ac_pplx", auth_scheme: "API_KEY", is_composio_managed: false },
        },
      };
    });

    const config = await composio.ensureAuthConfig({
      toolkit: "perplexityai",
      authSchemes: ["API_KEY"],
      managedAuthSchemes: [],
    });

    expect(config).toMatchObject({ id: "ac_pplx", scheme: "API_KEY", userSupplied: true });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      toolkit: { slug: "perplexityai" },
      auth_config: { type: "use_custom_auth", authScheme: "API_KEY", name: "perplexityai", credentials: {} },
    });
  });

  it("refuses a toolkit that needs its own OAuth client, with a readable reason", async () => {
    const { composio } = client(() => ({ status: 200, body: { items: [], next_cursor: null } }));

    const attempt = composio.ensureAuthConfig({
      toolkit: "twitter",
      authSchemes: ["OAUTH2"],
      managedAuthSchemes: [],
    });

    await expect(attempt).rejects.toMatchObject({ code: "not_configured" });
    await expect(attempt).rejects.toThrow(/twitter cannot be connected with Composio's own credentials yet/);
  });
});

describe("connect flow", () => {
  it("opens a link and returns the account to poll", async () => {
    const { composio, calls } = client(() => ({
      status: 201,
      body: {
        link_token: "lk_1",
        redirect_url: "https://connect.composio.dev/link/lk_1",
        expires_at: "2026-11-21T06:04:00.166Z",
        connected_account_id: "ca_new",
      },
    }));

    const link = await composio.startLink({ authConfigId: "ac_1", userId: "user_1", alias: "PupBot" });

    expect(link).toEqual({
      connectedAccountId: "ca_new",
      redirectUrl: "https://connect.composio.dev/link/lk_1",
      expiresAt: "2026-11-21T06:04:00.166Z",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ auth_config_id: "ac_1", user_id: "user_1", alias: "PupBot" });
    expect(calls[0]!.url.pathname).toBe("/api/v3.1/connected_accounts/link");
  });

  it("maps every status Composio reports, and never guesses on a new one", () => {
    expect(connectionStateFrom("INITIALIZING")).toBe("pending");
    expect(connectionStateFrom("INITIATED")).toBe("pending");
    expect(connectionStateFrom("ACTIVE")).toBe("active");
    expect(connectionStateFrom("FAILED")).toBe("failed");
    expect(connectionStateFrom("EXPIRED")).toBe("expired");
    expect(connectionStateFrom("REVOKED")).toBe("revoked");
    expect(connectionStateFrom("INACTIVE")).toBe("inactive");
    expect(connectionStateFrom("SOMETHING_NEW")).toBe("unknown");
  });

  it("reads a connection and falls back to the nested status", async () => {
    const { composio } = client(() => ({
      status: 200,
      body: connectionWire({ status: undefined, state: { val: { status: "ACTIVE" } } }),
    }));
    const connection = await composio.getConnection("ca_1");
    expect(connection).toMatchObject({ id: "ca_1", toolkit: "gmail", state: "active", authConfigId: "ac_1" });
  });

  it("treats a missing connection as gone rather than throwing", async () => {
    const { composio } = client(() => ({
      status: 404,
      body: { error: { message: 'Connected account "ca_1" not found', code: 606 } },
    }));
    await expect(composio.getConnection("ca_1")).resolves.toBeNull();
  });

  it("scopes the list to the given users", async () => {
    const { composio, calls } = client(() => ({
      status: 200,
      body: { items: [connectionWire({ status: "ACTIVE" })], next_cursor: null },
    }));

    const connections = await composio.listConnections({ userIds: ["u1", "u2"] });

    expect(connections).toHaveLength(1);
    expect(connections[0]!.state).toBe("active");
    expect(calls[0]!.url.searchParams.get("user_ids")).toBe("u1,u2");
  });

  it("does not call out at all when no user is in scope", async () => {
    const { composio, calls } = client(() => ({ status: 200, body: { items: [] } }));
    await expect(composio.listConnections({ userIds: [] })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("revokes upstream on delete, not just on Composio's records", async () => {
    const { composio, calls } = client(() => ({ status: 200, body: {} }));
    await composio.deleteConnection("ca_1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/api/v3.1/connected_accounts/ca_1");
    expect(calls[0]!.url.searchParams.get("revoke_on_delete")).toBe("true");
  });
});

describe("errors", () => {
  it("maps an invalid key to unauthorized and keeps the key out of the message", async () => {
    const { composio } = client(() => ({
      status: 401,
      body: { error: { message: "Invalid API key: tes**-one", slug: "APIKey_InvalidAPIKey", status: 401 } },
    }));

    const error = (await composio.listToolkits().catch((caught) => caught)) as ComposioError;

    expect(error).toBeInstanceOf(ComposioError);
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.detail).toBe("APIKey_InvalidAPIKey");
    expect(`${error.message} ${error.detail} ${error.stack}`).not.toContain(KEY);
  });

  it("reports an unreachable host as network, not as an empty marketplace", async () => {
    const composio = new ComposioClient({
      apiKey: KEY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(composio.listToolkits()).rejects.toMatchObject({ code: "network" });
  });

  it("reports a slow host as a timeout", async () => {
    const composio = new ComposioClient({
      apiKey: KEY,
      fetch: (async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }) as typeof fetch,
    });
    await expect(composio.listToolkits()).rejects.toMatchObject({ code: "timeout" });
  });

  it("never logs, whatever happens", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}),
    );
    const { composio } = client(() => ({ status: 500, body: { error: { message: "boom" } } }));
    await composio.listToolkits().catch(() => {});
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    spies.forEach((spy) => spy.mockRestore());
  });

  it("will not construct a client without a key", () => {
    expect(() => new ComposioClient({ apiKey: "" })).toThrow(ComposioError);
  });
});
