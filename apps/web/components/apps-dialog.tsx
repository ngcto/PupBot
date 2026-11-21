"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge, Button, DialogContent, DialogRoot, cn, toast } from "@terabot/ui";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { connectApp, disconnectApp, loadApps, pollApps } from "../app/apps/actions.ts";
import {
  actionFor,
  appsReducer,
  connectionFor,
  hasPending,
  initialAppsState,
  selectedApp,
  tileStateFor,
} from "../lib/apps-reducer.ts";
import type { AppCard, ConnectedApp } from "../lib/types.ts";

/**
 * The marketplace behind "Connect apps": browse, connect, done.
 *
 * The only technical detail a person sees is an app this beta genuinely cannot
 * connect yet, which is stated on the card instead of behind a button that would
 * fail. Everything else — auth configs, connected account ids, status words — stays
 * out of the way unless a connection breaks.
 */
export function AppsDialog({
  open,
  onOpenChange,
  initialConnections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialConnections: ConnectedApp[];
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(appsReducer, initialConnections, initialAppsState);
  const inFlight = useRef(0);

  const [retryToken, bumpRetry] = useReducer((n: number) => n + 1, 0);

  const load = useCallback(async (query: string, category: string | null) => {
    const ticket = ++inFlight.current;
    const result = await loadApps({
      search: query.trim() || undefined,
      category: category ?? undefined,
    });
    // A slow answer for an older query must not overwrite a newer one.
    if (ticket !== inFlight.current) return;
    dispatch({ type: "loaded", page: result });
    if (result.error) toast(result.error);
  }, []);

  // Opening reloads the catalogue, so a connection made on another device shows up.
  useEffect(() => {
    if (!open) return;
    dispatch({ type: "open", connections: initialConnections });
    void load("", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, retryToken]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void load(state.query, state.category), 200);
    return () => clearTimeout(timer);
  }, [open, state.query, state.category, load]);

  // Poll only while something is waiting on the person, and stop as soon as it lands.
  const waiting = hasPending(state);
  useEffect(() => {
    if (!open || !waiting) return;
    const timer = setInterval(async () => {
      const result = await pollApps();
      if (result.error) return;
      dispatch({ type: "connections", connections: result.connections });
      if (result.connections.every((connection) => connection.status !== "pending")) {
        void load(state.query, state.category);
        router.refresh();
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [open, waiting, load, router, state.query, state.category]);

  const app = selectedApp(state);
  const connection = app ? connectionFor(state, app.slug) : null;
  const kind = app ? actionFor(app, connection) : null;

  const onConnect = async () => {
    if (!app) return;
    dispatch({ type: "busy", toolkit: app.slug });
    // Open the window on the click itself: a browser drops the user activation that
    // allows a popup once the server action has been awaited, and the person would
    // see a blocked popup instead of Composio's page.
    const popup = window.open("", "_blank");
    const result = await connectApp(app.slug, window.location.origin);
    dispatch({ type: "busy", toolkit: null });
    if (result.error || !result.redirectUrl) {
      popup?.close();
      toast(result.error ?? "Could not start the connection.");
      return;
    }
    if (popup) {
      popup.location.href = result.redirectUrl;
    } else {
      // Popup blocked anyway: still let the person finish, in the same tab.
      window.location.href = result.redirectUrl;
      return;
    }
    const refreshed = await pollApps();
    if (!refreshed.error) dispatch({ type: "connections", connections: refreshed.connections });
    void load(state.query, state.category);
    // The rest of the shell (bot settings) reads connections from the server.
    router.refresh();
    toast(`Finish signing in to ${app.name} in the window that just opened.`);
  };

  const onDisconnect = async () => {
    if (!app || !connection) return;
    dispatch({ type: "busy", toolkit: app.slug });
    const result = await disconnectApp(connection.id);
    dispatch({ type: "busy", toolkit: null });
    if (result.error) {
      toast(result.error);
      return;
    }
    dispatch({ type: "disconnected", connectionId: connection.id });
    void load(state.query, state.category);
    router.refresh();
    toast(`${app.name} disconnected.`);
  };

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width={980}
        data-testid="apps-dialog"
        className="flex h-[640px] max-h-[92vh] flex-col overflow-hidden p-0"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-4">
          <p className="text-lg font-semibold text-ink">Connect apps</p>
          <Badge className="bg-raised text-xs text-ink-muted" data-testid="apps-connected-count">
            {state.connections.filter((entry) => entry.status === "active").length} connected
          </Badge>
          <div className="ml-auto flex h-8 w-[280px] items-center gap-2 rounded-pill bg-raised px-3">
            <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.8} className="text-ink-muted" />
            <input
              aria-label="Search apps"
              placeholder="Search apps"
              value={state.query}
              onChange={(event) => dispatch({ type: "query", query: event.target.value })}
              className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col border-r border-hairline">
            <CategoryRow
              categories={state.page?.categories ?? []}
              active={state.category}
              onSelect={(next) => dispatch({ type: "category", category: next })}
            />
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3">
              <Grid
                state={state}
                stateFor={(card) => tileStateFor(card, connectionFor(state, card.slug))}
                onSelect={(slug) => dispatch({ type: "select", slug })}
                onRetry={bumpRetry}
              />
            </div>
          </div>

          <div className="flex w-[352px] flex-none flex-col bg-dialog-nav">
            <AnimatePresence mode="wait" initial={false}>
              {app && kind ? (
                <motion.div
                  key={app.slug}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin"
                  data-testid="app-detail"
                >
                  <div className="flex flex-col items-start gap-3 p-5">
                    <AppLogo app={app} size={56} />
                    <div>
                      <p className="text-xl font-semibold text-ink">{app.name}</p>
                      <p className="mt-1 text-sm text-ink-muted">
                        {app.toolsCount > 0 ? `${app.toolsCount} actions` : "Ready to connect"}
                        {app.categories.length > 0 ? ` · ${app.categories.join(", ")}` : ""}
                      </p>
                    </div>
                    <p className="text-body leading-relaxed text-ink-secondary">{app.description}</p>
                  </div>

                  <div className="mx-5 rounded-lg bg-raised p-4 text-body leading-relaxed text-ink-secondary">
                    {connectCopy(app, kind)}
                  </div>

                  <div className="mt-auto p-5">
                    {kind === "connect" ? (
                      <Button
                        variant="primary"
                        className="h-9 w-full"
                        disabled={state.busy === app.slug}
                        onClick={onConnect}
                        data-testid="app-connect"
                      >
                        {state.busy === app.slug ? "Opening…" : `Connect ${app.name}`}
                      </Button>
                    ) : null}

                    {kind === "retry" ? (
                      <div className="space-y-2">
                        <p className="text-sm leading-relaxed text-danger" data-testid="app-failed">
                          {connection?.status === "error"
                            ? "That connection could not be completed."
                            : "Something went wrong."}
                        </p>
                        <Button
                          variant="primary"
                          className="h-9 w-full"
                          disabled={state.busy === app.slug}
                          onClick={onConnect}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : null}

                    {kind === "pending" ? (
                      <div className="rounded-lg bg-raised p-3" data-testid="app-pending">
                        <p className="text-body text-ink">Waiting for approval</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                          Finish signing in to {app.name} in the other window. This updates on its own.
                        </p>
                      </div>
                    ) : null}

                    {kind === "disconnect" ? (
                      <div className="flex items-center gap-2">
                        <Badge className="bg-[#123418] text-sm text-[#5ed37c]" data-testid="app-connected">
                          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.2} /> Connected
                        </Badge>
                        <Button
                          variant="ghost"
                          className="ml-auto h-9 gap-1.5 px-3 text-danger hover:bg-raised"
                          disabled={state.busy === app.slug}
                          onClick={onDisconnect}
                        >
                          <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.8} />
                          Disconnect
                        </Button>
                      </div>
                    ) : null}

                    {kind === "needs-setup" ? (
                      <div className="rounded-lg bg-raised p-3" data-testid="app-needs-setup">
                        <p className="text-body text-ink">Not available yet</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                          {app.name} needs its own developer sign-in (an OAuth client) before anyone can
                          connect it. That one is on the list; the rest of the marketplace works today.
                        </p>
                      </div>
                    ) : null}

                    <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                      Connecting links the account. Bots can be given the app, but no chat can use it yet —
                      that arrives with the tool-calling loop.
                    </p>
                  </div>
                </motion.div>
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-body text-ink-muted">
                  Pick an app to see what connecting does.
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function Grid({
  state,
  stateFor,
  onSelect,
  onRetry,
}: {
  state: ReturnType<typeof initialAppsState>;
  stateFor: (app: AppCard) => string;
  onSelect: (slug: string) => void;
  onRetry: () => void;
}) {
  if (state.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center" data-testid="apps-empty">
        <p className="text-body font-medium text-ink">Couldn&apos;t load apps</p>
        <p className="mt-1 max-w-[320px] text-sm leading-relaxed text-ink-muted">{state.error}</p>
        <Button size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (!state.page) return <GridSkeleton />;

  if (!state.page.configured) {
    return (
      <Empty
        title="Apps aren't set up yet"
        body="This server has no Composio project key, so nothing can be connected. An administrator adds COMPOSIO_PROJECT_API_KEY to the environment."
        testId="apps-unconfigured"
      />
    );
  }

  if (state.page.items.length === 0) {
    return (
      <Empty
        title="No apps match that"
        body={
          state.query
            ? `Nothing matches "${state.query}". Try a shorter word, like "mail" or "calendar".`
            : "This category is empty right now."
        }
        testId="apps-empty"
      />
    );
  }

  return (
    <div
      data-testid="apps-grid"
      className={cn("grid grid-cols-3 gap-1.5 transition-opacity", state.loading && "opacity-60")}
    >
      {state.page.items.map((card) => (
        <button
          key={card.slug}
          type="button"
          data-testid={`app-tile-${card.slug}`}
          onClick={() => onSelect(card.slug)}
          className={cn(
            "flex items-center gap-2.5 rounded-lg p-2.5 text-left transition-colors",
            card.slug === state.selected ? "bg-raised-2" : "hover:bg-raised",
          )}
        >
          <AppLogo app={card} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-ink">{card.name}</p>
            <p className="truncate text-sm text-ink-muted">{stateFor(card)}</p>
          </div>
          {stateFor(card) === "Connected" ? (
            <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} className="text-[#2f7cf6]" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function CategoryRow({
  categories,
  active,
  onSelect,
}: {
  categories: string[];
  active: string | null;
  onSelect: (category: string | null) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto scroll-thin border-b border-hairline px-3 py-2">
      {[null, ...categories.slice(0, 12)].map((category) => (
        <button
          key={category ?? "all"}
          type="button"
          onClick={() => onSelect(category)}
          className={cn(
            "h-7 flex-none rounded-pill px-3 text-sm capitalize transition-colors",
            active === category ? "bg-white text-[#111]" : "bg-raised text-ink-secondary hover:text-ink",
          )}
        >
          {category ?? "All"}
        </button>
      ))}
    </div>
  );
}

/** What connecting actually gets you, in plain words, per flow. */
function connectCopy(app: AppCard, kind: string): string {
  if (kind === "disconnect") {
    return `${app.name} is linked. Disconnecting revokes the access at ${app.name} itself, not just here.`;
  }
  if (kind === "pending") return "Approve the request in the window that opened, and this becomes connected.";
  if (app.support === "managed") {
    return `${app.name} opens its own sign-in page. Approve access and this app shows connected here; disconnect any time. Your password never passes through PupBot.`;
  }
  if (app.support === "user-key") {
    return `${app.name} signs in with an API key. Composio's page asks you to paste one; it is stored there, not here.`;
  }
  return `${app.name} can't be connected with the shared sign-in. It needs its own app registration first.`;
}

function AppLogo({ app, size }: { app: AppCard; size: number }) {
  return (
    <span
      className="relative flex flex-none items-center justify-center overflow-hidden rounded-[10px] bg-white"
      style={{ width: size, height: size }}
    >
      <span className="text-base font-semibold text-[#111]">{app.name.slice(0, 1).toUpperCase()}</span>
      {app.logoUrl ? (
        // Composio serves one logo per toolkit from logos.composio.dev. Kept as a
        // plain img so a blocked CDN degrades to the initial behind it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={app.logoUrl}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="absolute inset-0 size-full object-contain p-1"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-1.5" data-testid="apps-loading">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2.5 rounded-lg p-2.5">
          <span className="size-[34px] flex-none animate-pulse rounded-[10px] bg-raised" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-3 w-2/3 animate-pulse rounded bg-raised" />
            <span className="block h-2.5 w-1/2 animate-pulse rounded bg-raised" />
          </span>
        </div>
      ))}
    </div>
  );
}

function Empty({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-8 text-center"
      data-testid={testId}
    >
      <p className="text-body font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-[320px] text-sm leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
