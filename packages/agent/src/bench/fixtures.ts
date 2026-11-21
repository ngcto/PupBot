/**
 * The fixture tools the benchmark hands to every arm.
 *
 * `packages/cua` is not on `main` yet (PR #38), and driving a real desktop needs a
 * live GUI session, so the benchmark cannot call the real 26. What it can do is
 * hand all three arms the *same* 26 tools with deterministic local implementations,
 * which is what isolates the thing being compared: the shape of the tool surface and
 * how a result reaches the model.
 *
 * Every tool here is a pure function of its arguments and a seeded PRNG. No clock,
 * no randomness, no network — so two runs of the same task on the same arm cost the
 * same tokens and make the same calls, and a difference between arms is a difference
 * in the harness rather than in the world.
 *
 * What this deliberately does **not** model: real driver latency, real permission
 * refusals, and real accessibility trees. The report says so; nobody should read a
 * fixture number as a claim about CUA.
 */

/** A role from the accessibility-tree vocabulary the CUA index uses. */
const ROLES = [
  "button",
  "textfield",
  "statictext",
  "link",
  "checkbox",
  "combobox",
  "listitem",
  "row",
  "cell",
  "image",
] as const;

export interface TreeRow {
  token: string;
  role: string;
  label: string;
  depth: number;
  bounds: { x: number; y: number; w: number; h: number };
  actionable: boolean;
  value?: string;
}

/** Deterministic 32-bit hash, so a token is stable for a given index and never depends on time. */
function mix(n: number): number {
  let x = n + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/**
 * A window's tree. `index` picks which fixture window, `rows` how large.
 *
 * `Approve invoice` appears exactly once per tree, at a position that is a function
 * of the window index, so a task can ask for it and the answer is checkable without
 * the model being able to guess it from a pattern.
 */
export function treeFor(index: number, rows: number): TreeRow[] {
  return Array.from({ length: rows }, (_, i) => {
    const h = mix(index * 100_003 + i);
    const role = ROLES[h % ROLES.length]!;
    // Exactly one row per tree carries the target label, and its position is a
    // function of the window index only — so a test can assert uniqueness rather
    // than hope for it.
    const target = i === (index * 7) % rows;
    return {
      token: `t${(index * 7 + i).toString(36)}${(h % 4096).toString(36)}`,
      role,
      label: target ? "Approve invoice" : `Item ${i} ${role === "textfield" ? "entry" : "row"}`,
      depth: h % 5,
      bounds: { x: h % 1200, y: (h >>> 8) % 900, w: 60 + (h % 80), h: 20 + (h % 12) },
      actionable: role === "button" || role === "textfield" || role === "link" || role === "checkbox",
      ...(role === "textfield" ? { value: "" } : {}),
    };
  });
}

export interface WindowFixture {
  id: string;
  app: string;
  title: string;
  rows: number;
}

/** The fixture windows. Three is enough to make "find the one called X" a real lookup. */
export const WINDOWS: WindowFixture[] = [
  { id: "w1", app: "Invoices", title: "Invoices — November", rows: 24 },
  { id: "w2", app: "Mail", title: "Inbox", rows: 18 },
  { id: "w3", app: "Editor", title: "notes.md", rows: 12 },
];

export const APPS = ["Invoices", "Mail", "Editor", "Browser"];

/** What a single action did. The ladder is the contract, so `effect` is not a boolean. */
export interface ActionEffect {
  effect: "confirmed" | "unverifiable" | "refused";
  verified: boolean;
  escalation?: { recommended: "foreground" | "retry" | "observe"; reason: string };
  refusal?: { code: string; message: string };
  target?: string;
}

/** State a task's actions mutate, so a multi-step task can be verified at the end. */
export interface WorldState {
  values: Map<string, string>;
  clicked: string[];
  launched: string | null;
  navigated: string | null;
  submitted: boolean;
  /** Set to a token to make the first click on it refuse, for the recovery task. */
  staleToken?: string;
}

export function freshWorld(): WorldState {
  return {
    values: new Map(),
    clicked: [],
    launched: null,
    navigated: null,
    submitted: false,
  };
}

/**
 * The 26 implementations, keyed by the exact names the CUA index uses.
 *
 * Each returns the same structured shape the real driver does — `effect`,
 * `verified`, and an `escalation` or `refusal` where the real one would have one —
 * because a program that branches on `effect` has to see a real one.
 */
export function fixtureImplementations(world: WorldState): Record<string, (input: Record<string, unknown>) => unknown> {
  const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const tree = (id: string): TreeRow[] => {
    const window = WINDOWS.find((w) => w.id === id) ?? WINDOWS[0]!;
    return treeFor(WINDOWS.indexOf(window) + 1, window.rows);
  };
  const ok = (target: string): ActionEffect => ({ effect: "confirmed", verified: true, target });

  const impl: Record<string, (input: Record<string, unknown>) => unknown> = {
    listWindows: () => WINDOWS.map((w) => ({ id: w.id, app: w.app, title: w.title, pid: 4000 + WINDOWS.indexOf(w) })),
    listApps: () => APPS.map((app, i) => ({ app, pid: 4000 + i, running: app !== "Browser" })),
    launchApp: ({ app }) => {
      const name = str(app);
      world.launched = name;
      return { effect: "confirmed", verified: true, app: name, windows: [{ id: "w9", app: name, title: `${name} — Untitled` }] };
    },
    observeWindow: ({ windowId, screenshot }) => {
      const id = str(windowId);
      const window = WINDOWS.find((w) => w.id === id);
      // An unknown or missing window id is refused, not quietly answered with the first
      // window. The silent default made a wrong argument look like a wrong *answer*: a
      // program that read `observeWindow({ window: "w2" })` — the native schema's name
      // for the argument, not the program's — got Invoices back and reported that the
      // tool "returned the wrong window". The real driver refuses an id it does not
      // know, and a fixture that does not is measuring the model's patience with a lie.
      if (!window) {
        return {
          effect: "refused",
          verified: false,
          target: id || "(missing)",
          refusal: {
            code: id ? "unknown_window" : "missing_window_id",
            message: id ? `no window with id ${id}` : "observeWindow needs a windowId from listWindows",
          },
          escalation: { recommended: "observe", reason: "list the windows and use one of those ids" },
        };
      }
      const rows = tree(id);
      return {
        windowId: window.id,
        app: window.app,
        title: window.title,
        snapshotId: `snap_${id}`,
        degraded: rows.every((r) => !r.actionable),
        rows,
        outline: rows.map((r) => `${"  ".repeat(r.depth)}[${r.token}] ${r.role} "${r.label}"`).join("\n"),
        ...(screenshot ? { screenshot: "<an image; cost not measurable on this endpoint>" } : {}),
      };
    },
    observeDesktop: () => ({ windows: WINDOWS.map((w) => ({ id: w.id, app: w.app, title: w.title })), screenshot: "<an image>" }),
    click: ({ token }) => {
      const t = str(token);
      if (world.staleToken && t === world.staleToken) {
        return {
          effect: "refused",
          verified: false,
          target: t,
          refusal: { code: "stale_token", message: "that token is from an older snapshot" },
          escalation: { recommended: "observe", reason: "re-read the window before acting" },
        } satisfies ActionEffect;
      }
      world.clicked.push(t);
      return ok(t);
    },
    doubleClick: ({ token }) => ok(str(token)),
    rightClick: ({ token }) => ({ ...ok(str(token)), menu: ["Copy", "Paste", "Inspect"] }),
    typeText: ({ token, text }) => {
      const t = str(token) || "focused";
      world.values.set(t, str(text));
      return ok(t);
    },
    pressKey: ({ key }) => ok(str(key)),
    hotkey: ({ keys }) => ok(Array.isArray(keys) ? keys.join("+") : str(keys)),
    scroll: ({ windowId, direction }) => ({ ...ok(str(windowId) || "w1"), direction: str(direction) || "down", scrolled: true }),
    setValue: ({ token, value }) => {
      const t = str(token) || "focused";
      world.values.set(t, str(value));
      return ok(t);
    },
    screenshot: () => ({
      effect: "confirmed",
      verified: false,
      image: "<an image; the endpoint does not forward pixels, so its token cost is unmeasurable>",
    }),
    runSteps: ({ steps }) => {
      const list = Array.isArray(steps) ? steps : [];
      const results = list.map((step) => {
        const record = (step ?? {}) as Record<string, unknown>;
        const name = str(record.tool) || "click";
        const run = impl[name];
        return run ? run((record.args ?? {}) as Record<string, unknown>) : { effect: "refused", verified: false };
      });
      return { effect: results.every((r) => (r as ActionEffect).effect === "confirmed") ? "confirmed" : "unverifiable", verified: true, steps: results };
    },
    prepareBrowser: () => ({ effect: "confirmed", verified: true, target: "driver-owned", tabs: [{ id: "tab1", url: "about:blank" }] }),
    browserState: () => ({ targetId: "tab1", tabs: [{ id: "tab1", url: "https://example.test/", title: "Example" }] }),
    browserNavigate: ({ url }) => {
      world.navigated = str(url);
      return { effect: "confirmed", verified: true, url: str(url) };
    },
    readPage: ({ url }) => ({
      url: str(url) || "https://example.test/",
      title: "Example Domain",
      challenge: { gated: false, kind: null },
      rows: tree("w3").slice(0, 10),
    }),
    browserClick: ({ ref }) => ok(str(ref)),
    browserType: ({ ref, text }) => {
      const r = str(ref);
      world.values.set(r, str(text));
      return ok(r);
    },
    browserSelect: ({ ref, value }) => {
      const r = str(ref);
      world.values.set(r, str(value));
      return ok(r);
    },
    browserPointer: ({ ref, action }) => ({ ...ok(str(ref)), action: str(action) || "hover" }),
    browserDialog: ({ action }) => ({ ...ok("dialog"), action: str(action) || "accept" }),
    assessChallenge: () => ({ gated: false, recommendation: "proceed", reasons: ["no challenge detected in page state"] }),
    detectCaptcha: () => ({ gated: false, kind: null, signals: [] }),
  };

  return impl;
}
