import type { AppCard, AppList, ConnectedApp } from "./types.ts";

/**
 * The marketplace's state machine, kept out of the component so the transitions
 * that matter — search, category, loading, failure, connect, poll, disconnect — are
 * testable without a browser.
 *
 * The rule the reducer enforces: a failure is a failure. An empty grid is only ever
 * "no apps match", never a swallowed error, because a marketplace that looks empty
 * when the API is down is a lie a person cannot tell from a product with no apps.
 */

export interface AppsState {
  query: string;
  category: string | null;
  selected: string | null;
  page: AppList | null;
  loading: boolean;
  error: string | null;
  /** The user's connections, freshest first as Composio reported them. */
  connections: ConnectedApp[];
  /** The toolkit with an action in flight, so only its own button shows progress. */
  busy: string | null;
}

export type AppsAction =
  | { type: "open"; connections: ConnectedApp[] }
  | { type: "query"; query: string }
  | { type: "category"; category: string | null }
  | { type: "loaded"; page: AppList }
  | { type: "failed"; error: string }
  | { type: "select"; slug: string }
  | { type: "busy"; toolkit: string | null }
  | { type: "connections"; connections: ConnectedApp[] }
  | { type: "disconnected"; connectionId: string };

export function initialAppsState(connections: ConnectedApp[] = []): AppsState {
  return {
    query: "",
    category: null,
    selected: null,
    page: null,
    loading: true,
    error: null,
    connections,
    busy: null,
  };
}

export function appsReducer(state: AppsState, action: AppsAction): AppsState {
  switch (action.type) {
    case "open":
      return { ...state, connections: action.connections, loading: true, error: null };
    case "query":
      return { ...state, query: action.query, loading: true };
    case "category":
      return { ...state, category: action.category, loading: true };
    case "loaded": {
      // Keep the current pick if it survived the filter; otherwise land on the first
      // result, so the detail panel is never empty beside a full grid.
      const stillThere = action.page.items.some((item) => item.slug === state.selected);
      return {
        ...state,
        page: action.page,
        loading: false,
        error: action.page.error,
        selected: stillThere ? state.selected : (action.page.items[0]?.slug ?? null),
      };
    }
    case "failed":
      return { ...state, page: null, loading: false, error: action.error, selected: null };
    case "select":
      return { ...state, selected: action.slug };
    case "busy":
      return { ...state, busy: action.toolkit };
    case "connections": {
      const pending = action.connections.some((connection) => connection.status === "pending");
      return { ...state, connections: action.connections, loading: pending ? state.loading : false };
    }
    case "disconnected":
      return {
        ...state,
        connections: state.connections.filter((connection) => connection.id !== action.connectionId),
      };
    default:
      return state;
  }
}

/** The selected app, from a fresh page or, before one loads, from a kept card. */
export function selectedApp(state: AppsState): AppCard | null {
  return state.page?.items.find((item) => item.slug === state.selected) ?? null;
}

/** The user's connection for a toolkit, preferring an active one over a stale pending. */
export function connectionFor(state: AppsState, slug: string): ConnectedApp | null {
  const matches = state.connections.filter((connection) => connection.toolkit === slug);
  return matches.find((connection) => connection.status === "active") ?? matches[0] ?? null;
}

export function hasPending(state: AppsState): boolean {
  return state.connections.some((connection) => connection.status === "pending");
}

/**
 * What the detail panel's action area shows. Computed once so the copy and the
 * control can never disagree: no "Connect" button on an app that cannot connect.
 */
export type AppActionKind = "connect" | "pending" | "retry" | "disconnect" | "needs-setup";

export function actionFor(app: AppCard, connection: ConnectedApp | null): AppActionKind {
  if (connection?.status === "active") return "disconnect";
  if (connection?.status === "pending") return "pending";
  if (connection?.status === "error") return "retry";
  if (app.support === "needs-setup") return "needs-setup";
  return "connect";
}

/** The one-line state under an app's name in the grid. */
export function tileStateFor(app: AppCard, connection: ConnectedApp | null): string {
  if (connection?.status === "active") return "Connected";
  if (connection?.status === "pending") return "Waiting for approval";
  if (connection?.status === "error") return "Couldn't connect";
  if (app.support === "needs-setup") return "Needs setup";
  return "Available";
}
