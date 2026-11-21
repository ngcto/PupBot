import { resetEnvCache } from "@pupbot/config";
import { loadEnv } from "@pupbot/config/load-env";
import {
  appConnection,
  auth,
  bot,
  botApp,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  newId,
} from "@pupbot/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  botAppIds,
  disconnectConnection,
  listApps,
  listConnectionsFor,
  refreshConnections,
  setBotApp,
  startConnection,
} from "../lib/apps.ts";

loadEnv();

/**
 * These exercise the scoping rules against the real schema: a connection is only
 * visible to the user who made it, only deletable by them, and a bot may only be
 * given an app from its own workspace. Composio itself is stubbed at the HTTP
 * layer, so no project key and no network are involved.
 */

type StubReply = { status?: number; body?: unknown };

function installComposioStub() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const connections = new Map<string, { id: string; toolkit: string; status: string }>();
  // Each install gets its own id space: rows live in a real database that outlives
  // the test, and Composio's ids are unique per project.
  const run = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3.1", "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const reply = (payload: unknown, status = 200): StubReply => ({ body: payload, status });

    if (path === "/toolkits") {
      return respond(
        reply({
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              auth_schemes: ["OAUTH2"],
              composio_managed_auth_schemes: ["OAUTH2"],
              meta: { description: "mail", logo: "l", categories: [{ name: "email" }], tools_count: 3 },
            },
            {
              slug: "twitter",
              name: "Twitter",
              auth_schemes: ["OAUTH2"],
              composio_managed_auth_schemes: [],
              meta: { description: "social", logo: "l", categories: [{ name: "social" }], tools_count: 3 },
            },
          ],
          next_cursor: null,
        }),
      );
    }
    const single = path.match(/^\/toolkits\/([^/]+)$/);
    if (single) {
      const slug = single[1]!;
      const managed = slug === "gmail";
      return respond(
        reply(slug === "gmail" || slug === "twitter"
          ? {
              slug,
              name: slug === "gmail" ? "Gmail" : "Twitter",
              auth_schemes: ["OAUTH2"],
              composio_managed_auth_schemes: managed ? ["OAUTH2"] : [],
              meta: { description: slug, logo: "l", categories: [{ name: slug }] },
            }
          : null,
          slug === "gmail" || slug === "twitter" ? 200 : 404),
      );
    }
    if (path === "/auth_configs" && method === "GET") {
      return respond(reply({ items: [], next_cursor: null }));
    }
    if (path === "/auth_configs" && method === "POST") {
      counter += 1;
      return respond(
        reply({ toolkit: { slug: "gmail" }, auth_config: { id: `ac_${run}_${counter}`, auth_scheme: "OAUTH2", is_composio_managed: true } }, 201),
      );
    }
    if (path === "/connected_accounts/link") {
      counter += 1;
      const id = `ca_${run}_${counter}`;
      connections.set(id, { id, toolkit: "gmail", status: "INITIALIZING" });
      return respond(
        reply(
          {
            link_token: `lk_${id}`,
            redirect_url: `https://connect.stub.test/${id}`,
            expires_at: "2026-11-21T06:04:00Z",
            connected_account_id: id,
          },
          201,
        ),
      );
    }
    const one = path.match(/^\/connected_accounts\/([^/]+)$/);
    if (one && method === "GET") {
      const found = connections.get(one[1]!);
      if (!found) return respond(reply({ error: { message: "not found" } }, 404));
      found.status = "ACTIVE";
      return respond(
        reply({ id: found.id, status: found.status, toolkit: { slug: "gmail" }, auth_config: { id: "ac_1" } }),
      );
    }
    if (one && method === "DELETE") {
      if (url.searchParams.get("revoke_on_delete") !== "true") return respond(reply({ error: {} }, 400));
      connections.delete(one[1]!);
      return respond(reply({ success: true }));
    }
    return respond(reply({ error: { message: `unexpected ${method} ${path}` } }, 404));
  }) as typeof fetch;

  process.env.COMPOSIO_PROJECT_API_KEY = "test-key-not-real";
  process.env.COMPOSIO_BASE_URL = "http://stub.test/api/v3.1";
  // serverEnv() memoises; each install has to be visible to the next read.
  resetEnvCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;

  return {
    calls,
    connections,
    restore: () => {
      globalThis.fetch = realFetch;
      delete process.env.COMPOSIO_PROJECT_API_KEY;
      delete process.env.COMPOSIO_BASE_URL;
      resetEnvCache();
    },
  };
}

function respond(reply: StubReply) {
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

async function person(name: string) {
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@pupbot.dev`;
  const signUp = await auth().api.signUpEmail({
    body: { email, password: "apps-test-password", name },
    returnHeaders: true,
  });
  const user = signUp.response.user;
  const workspace = await ensureWorkspace(user.id, name);
  return { userId: user.id, workspaceId: workspace.id };
}

async function makeBot(workspaceId: string, name: string) {
  const id = newId();
  await database().insert(bot).values({
    id,
    workspaceId,
    name,
    avatar: { shape: "circle", color: "mint" },
    accentColor: "#5ed37c",
  });
  await database().insert(conversation).values({ id: newId(), botId: id, title: name });
  return id;
}

afterAll(async () => {
  await closeDatabase();
});

describe("app connection scoping", () => {
  it("records a reference, never a credential, and keeps it private to its user", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      const bob = await person("Bob");

      const started = await startConnection({
        userId: alice.userId,
        workspaceId: alice.workspaceId,
        toolkit: "gmail",
      });
      expect(started.redirectUrl).toContain("connect.stub.test");

      const [row] = await database()
        .select()
        .from(appConnection)
        .where(eq(appConnection.userId, alice.userId));
      expect(row).toMatchObject({
        toolkit: "gmail",
        status: "pending",
        composioAccountId: started.connectionId,
      });
      expect(row!.authConfigId).toMatch(/^ac_/);
      // The schema has no column that could hold a token: the row is the reference.
      expect(Object.keys(row!)).not.toContain("accessToken");
      expect(Object.keys(row!)).not.toContain("encryptedCredential");

      // Bob sees nothing of Alice's, and cannot disconnect it.
      expect(await listConnectionsFor(bob.userId)).toEqual([]);
      await expect(
        disconnectConnection({ userId: bob.userId, connectionId: row!.id }),
      ).rejects.toThrow(/not yours/);
      expect(stub.connections.size).toBe(1);

      // Alice's own list does include it.
      expect((await listConnectionsFor(alice.userId)).map((entry) => entry.toolkit)).toEqual(["gmail"]);
    } finally {
      stub.restore();
    }
  });

  it("moves a pending connection to active when Composio says so", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      await startConnection({ userId: alice.userId, workspaceId: alice.workspaceId, toolkit: "gmail" });

      const refreshed = await refreshConnections(alice.userId);
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]).toMatchObject({ toolkit: "gmail", status: "active" });

      const [row] = await database().select().from(appConnection).where(eq(appConnection.userId, alice.userId));
      expect(row).toMatchObject({ status: "active", statusDetail: "ACTIVE", lastError: null });
    } finally {
      stub.restore();
    }
  });

  it("revokes at Composio before forgetting the row", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      const started = await startConnection({
        userId: alice.userId,
        workspaceId: alice.workspaceId,
        toolkit: "gmail",
      });
      const [row] = await database().select().from(appConnection).where(eq(appConnection.userId, alice.userId));

      await disconnectConnection({ userId: alice.userId, connectionId: row!.id });

      const del = stub.calls.find((call) => call.method === "DELETE" && call.path.includes(started.connectionId));
      expect(del).toBeDefined();
      expect(stub.connections.size).toBe(0);
      expect(await database().select().from(appConnection).where(eq(appConnection.id, row!.id))).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("keeps the row when Composio refuses to revoke, so a live grant is never orphaned", async () => {
    const alice = await person("Alice");
    process.env.COMPOSIO_PROJECT_API_KEY = "test-key-not-real";
    process.env.COMPOSIO_BASE_URL = "http://stub.test/api/v3.1";
    resetEnvCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ error: { message: "boom" } }, { status: 500 })) as typeof fetch;

    try {
      const [row] = await database()
        .insert(appConnection)
        .values({
          id: newId(),
          workspaceId: alice.workspaceId,
          userId: alice.userId,
          toolkit: "slack",
          name: "Slack",
          composioAccountId: `ca_orphan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          authConfigId: "ac_1",
          status: "active",
        })
        .returning();

      await expect(
        disconnectConnection({ userId: alice.userId, connectionId: row!.id }),
      ).rejects.toThrow(/could not revoke/);

      const still = await database().select().from(appConnection).where(eq(appConnection.id, row!.id));
      expect(still).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.COMPOSIO_PROJECT_API_KEY;
      delete process.env.COMPOSIO_BASE_URL;
      resetEnvCache();
    }
  });

  it("refuses a toolkit this beta cannot connect, naming what it needs", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      await expect(
        startConnection({ userId: alice.userId, workspaceId: alice.workspaceId, toolkit: "twitter" }),
      ).rejects.toThrow(/cannot be connected with Composio's own credentials yet/);
      expect(await database().select().from(appConnection).where(eq(appConnection.userId, alice.userId))).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("reports each app's three states honestly in the catalogue", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      await startConnection({ userId: alice.userId, workspaceId: alice.workspaceId, toolkit: "gmail" });
      await refreshConnections(alice.userId);

      const list = await listApps({ userId: alice.userId });
      expect(list.configured).toBe(true);
      expect(list.error).toBeNull();

      const gmail = list.items.find((item) => item.slug === "gmail")!;
      expect(gmail).toMatchObject({ state: "connected", support: "managed" });

      const twitter = list.items.find((item) => item.slug === "twitter")!;
      expect(twitter).toMatchObject({ state: "available", support: "needs-setup" });
    } finally {
      stub.restore();
    }
  });

  it("says it is unconfigured instead of showing an empty grid", async () => {
    const alice = await person("Alice");
    delete process.env.COMPOSIO_PROJECT_API_KEY;
    resetEnvCache();
    const list = await listApps({ userId: alice.userId });
    expect(list).toMatchObject({ configured: false, items: [], error: null });
  });
});

describe("per-bot app allow-list", () => {
  it("grants and revokes an app for one bot of the same workspace only", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      const bob = await person("Bob");
      const aliceBot = await makeBot(alice.workspaceId, "Scout");
      const bobBot = await makeBot(bob.workspaceId, "Rex");

      await startConnection({ userId: alice.userId, workspaceId: alice.workspaceId, toolkit: "gmail" });
      await refreshConnections(alice.userId);
      const [connection] = await database().select().from(appConnection).where(eq(appConnection.userId, alice.userId));
      expect(connection!.status).toBe("active");

      await setBotApp({
        workspaceId: alice.workspaceId,
        botId: aliceBot,
        connectionId: connection!.id,
        enabled: true,
      });
      expect(await botAppIds(aliceBot)).toEqual([connection!.id]);

      // Another workspace cannot hand its bot Alice's connection.
      await expect(
        setBotApp({
          workspaceId: bob.workspaceId,
          botId: bobBot,
          connectionId: connection!.id,
          enabled: true,
        }),
      ).rejects.toThrow(/no longer exists/);
      expect(await botAppIds(bobBot)).toEqual([]);

      await setBotApp({
        workspaceId: alice.workspaceId,
        botId: aliceBot,
        connectionId: connection!.id,
        enabled: false,
      });
      expect(await botAppIds(aliceBot)).toEqual([]);

      const remaining = await database()
        .select()
        .from(botApp)
        .where(and(eq(botApp.botId, aliceBot), eq(botApp.connectionId, connection!.id)));
      expect(remaining).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("will not let a bot use an app that is not connected yet", async () => {
    const stub = installComposioStub();
    try {
      const alice = await person("Alice");
      const aliceBot = await makeBot(alice.workspaceId, "Scout");
      await startConnection({ userId: alice.userId, workspaceId: alice.workspaceId, toolkit: "gmail" });
      const [connection] = await database().select().from(appConnection).where(eq(appConnection.userId, alice.userId));
      expect(connection!.status).toBe("pending");

      await expect(
        setBotApp({
          workspaceId: alice.workspaceId,
          botId: aliceBot,
          connectionId: connection!.id,
          enabled: true,
        }),
      ).rejects.toThrow(/Connect the app before a bot can use it/);
      expect(await botAppIds(aliceBot)).toEqual([]);
    } finally {
      stub.restore();
    }
  });
});
