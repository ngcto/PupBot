import { describe, expect, it } from "vitest";
import {
  actionFor,
  appsReducer,
  connectionFor,
  hasPending,
  initialAppsState,
  selectedApp,
  tileStateFor,
} from "../lib/apps-reducer.ts";
import type { AppCard, AppList, ConnectedApp } from "../lib/types.ts";

const app = (overrides: Partial<AppCard> = {}): AppCard => ({
  slug: "gmail",
  name: "Gmail",
  description: "mail",
  logoUrl: "https://logos.test/gmail",
  appUrl: null,
  categories: ["email"],
  toolsCount: 3,
  support: "managed",
  authConfigId: null,
  authConfigManaged: null,
  state: "available",
  connectionId: null,
  statusDetail: null,
  lastError: null,
  ...overrides,
});

const page = (items: AppCard[], overrides: Partial<AppList> = {}): AppList => ({
  items,
  nextCursor: null,
  categories: [...new Set(items.flatMap((item) => item.categories))],
  configured: true,
  error: null,
  ...overrides,
});

const connection = (overrides: Partial<ConnectedApp> = {}): ConnectedApp => ({
  id: "conn-1",
  toolkit: "gmail",
  name: "Gmail",
  status: "active",
  createdAt: "2026-11-21T00:00:00Z",
  botEnabled: false,
  ...overrides,
});

describe("marketplace reducer", () => {
  it("starts loading, because nothing is known yet", () => {
    const state = initialAppsState();
    expect(state.loading).toBe(true);
    expect(state.page).toBeNull();
    expect(state.error).toBeNull();
  });

  it("lands on the first result so the detail panel is never blank beside a grid", () => {
    const state = appsReducer(initialAppsState(), {
      type: "loaded",
      page: page([app({ slug: "gmail" }), app({ slug: "slack", name: "Slack" })]),
    });
    expect(state.loading).toBe(false);
    expect(selectedApp(state)?.slug).toBe("gmail");
  });

  it("keeps the current pick when a filter still contains it", () => {
    let state = appsReducer(initialAppsState(), {
      type: "loaded",
      page: page([app({ slug: "gmail" }), app({ slug: "slack", name: "Slack" })]),
    });
    state = appsReducer(state, { type: "select", slug: "slack" });
    state = appsReducer(state, { type: "query", query: "sl" });
    state = appsReducer(state, { type: "loaded", page: page([app({ slug: "slack", name: "Slack" })]) });
    expect(selectedApp(state)?.slug).toBe("slack");
  });

  it("moves the pick when the filter removed what was selected", () => {
    let state = appsReducer(initialAppsState(), {
      type: "loaded",
      page: page([app({ slug: "gmail" }), app({ slug: "slack", name: "Slack" })]),
    });
    state = appsReducer(state, { type: "select", slug: "slack" });
    state = appsReducer(state, { type: "loaded", page: page([app({ slug: "gmail" })]) });
    expect(selectedApp(state)?.slug).toBe("gmail");
  });

  it("clears the selection when nothing matches, and says the grid is empty", () => {
    let state = appsReducer(initialAppsState(), { type: "loaded", page: page([app()]) });
    state = appsReducer(state, { type: "query", query: "zzz" });
    state = appsReducer(state, { type: "loaded", page: page([]) });
    expect(state.loading).toBe(false);
    expect(selectedApp(state)).toBeNull();
    expect(state.page?.items).toEqual([]);
    expect(state.error).toBeNull();
  });

  it("treats a Composio failure as an error, never as an empty catalogue", () => {
    const state = appsReducer(initialAppsState(), {
      type: "loaded",
      page: page([], { error: "Composio did not answer. Check the connection and try again." }),
    });
    expect(state.error).toBe("Composio did not answer. Check the connection and try again.");
    expect(state.loading).toBe(false);
  });

  it("records an unconfigured server instead of pretending there are no apps", () => {
    const state = appsReducer(initialAppsState(), {
      type: "loaded",
      page: page([], { configured: false }),
    });
    expect(state.page?.configured).toBe(false);
    expect(state.error).toBeNull();
  });

  it("marks a server that is not configured while a request itself failed", () => {
    const state = appsReducer(initialAppsState(), { type: "failed", error: "network down" });
    expect(state).toMatchObject({ page: null, loading: false, error: "network down", selected: null });
  });
});

describe("connection state", () => {
  it("prefers the active connection over an older pending one", () => {
    const state = {
      ...initialAppsState([
        connection({ id: "old", status: "pending" }),
        connection({ id: "new", status: "active" }),
      ]),
    };
    expect(connectionFor(state, "gmail")?.id).toBe("new");
  });

  it("knows when something is still waiting on the user", () => {
    expect(hasPending(initialAppsState([connection({ status: "pending" })]))).toBe(true);
    expect(hasPending(initialAppsState([connection({ status: "active" })]))).toBe(false);
  });

  it("drops a disconnected app from the list", () => {
    const state = appsReducer(initialAppsState([connection()]), { type: "disconnected", connectionId: "conn-1" });
    expect(state.connections).toEqual([]);
  });

  it("does not treat an unanswered poll while waiting as a finished load", () => {
    const state = appsReducer(initialAppsState([connection({ status: "pending" })]), {
      type: "connections",
      connections: [connection({ status: "pending" })],
    });
    expect(state.connections[0]?.status).toBe("pending");
  });
});

describe("browsing the catalogue", () => {
  it("appends a second page and moves the cursor on", () => {
    const first = appsReducer(initialAppsState(), { type: "loaded", page: page([app({ slug: "gmail" })], { nextCursor: "c1" }) });
    const second = appsReducer(first, {
      type: "more",
      page: page([app({ slug: "slack" })], { nextCursor: "c2" }),
    });
    expect(second.page?.items.map((item) => item.slug)).toEqual(["gmail", "slack"]);
    expect(second.page?.nextCursor).toBe("c2");
  });

  it("does not repeat an app the next page overlaps on", () => {
    const first = appsReducer(initialAppsState(), { type: "loaded", page: page([app({ slug: "gmail" })]) });
    const second = appsReducer(first, {
      type: "more",
      page: page([app({ slug: "gmail" }), app({ slug: "notion" })]),
    });
    expect(second.page?.items.map((item) => item.slug)).toEqual(["gmail", "notion"]);
  });
});

describe("what an app offers", () => {
  it("offers Connect for an app this beta can link", () => {
    expect(actionFor(app(), null)).toBe("connect");
    expect(tileStateFor(app(), null)).toBe("Available");
  });

  it("never offers a button that cannot complete", () => {
    const twitter = app({ slug: "twitter", support: "needs-setup" });
    expect(actionFor(twitter, null)).toBe("needs-setup");
    expect(tileStateFor(twitter, null)).toBe("Needs setup");
  });

  it("connects a toolkit that needs setup once the project holds an auth config for it", () => {
    // An administrator registered an OAuth client, so the one thing that blocked the
    // app is gone; ensureAuthConfig would reuse that config.
    const registered = app({ slug: "twitter", support: "needs-setup", authConfigId: "ac_1", authConfigManaged: false });
    expect(actionFor(registered, null)).toBe("connect");
    expect(tileStateFor(registered, null)).toBe("Available");
  });

  it("says it is waiting while the user is on Composio's page", () => {
    expect(actionFor(app(), connection({ status: "pending" }))).toBe("pending");
    expect(tileStateFor(app(), connection({ status: "pending" }))).toBe("Waiting for approval");
  });

  it("offers Disconnect once connected, whatever the app supports", () => {
    const connected = connection({ status: "active" });
    expect(actionFor(app(), connected)).toBe("disconnect");
    expect(actionFor(app({ support: "user-key" }), connected)).toBe("disconnect");
    expect(tileStateFor(app(), connected)).toBe("Connected");
  });

  it("offers a retry only after a failed attempt", () => {
    expect(actionFor(app(), connection({ status: "error" }))).toBe("retry");
    expect(tileStateFor(app(), connection({ status: "error" }))).toBe("Couldn't connect");
  });
});
