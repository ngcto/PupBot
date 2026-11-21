/**
 * The 26 CUA tools as JSON Schema, for measurement only. Shapes are derived
 * from the typed signatures in handoffs/ngs-79-cua-interface.md.
 */
type J = Record<string, unknown>;
const s = (description: string, extra: J = {}): J => ({ type: "string", description, ...extra });
const n = (description: string, extra: J = {}): J => ({ type: "number", description, ...extra });
const b = (description: string): J => ({ type: "boolean", description });
const obj = (properties: J, required: string[] = []): J => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const target = obj({ pid: n("process id"), windowId: n("window id"), app: s("app name"), window: s("window title") });
const tab = { targetId: s("browser target id"), tabId: s("tab id") };

export const TOOLS: { name: string; description: string; parameters: J }[] = [
  { name: "list_windows", description: "List the open windows on the computer: pid, window id, app, title, z-index.",
    parameters: obj({ pid: n("only this process"), app: s("only this app") }) },
  { name: "list_apps", description: "List the GUI apps running on the computer.", parameters: obj({}) },
  { name: "launch_app", description: "Start an app in the background without raising it; returns the windows it opened.",
    parameters: obj({ app: s("app name"), urls: { type: "array", items: { type: "string" } }, forceNewInstance: b("start a second instance") }, ["app"]) },
  { name: "observe_window", description: "Read one window: accessibility tree as rows and a compact outline, plus a snapshot id.",
    parameters: obj({ target, screenshot: b("include the image, which is expensive"), since: s("'latest' or a snapshot id, for only changed rows"), format: s("'elements' or 'markdown'"), maxElements: n("cap rows"), query: s("narrow to one element's subtree") }, ["target"]) },
  { name: "observe_desktop", description: "Read the whole display, with a screenshot, for surfaces with no window or tree.",
    parameters: obj({ screenshot: b("include the image") }) },
  { name: "click", description: "Click one exact target: an element token from a fresh observation, or window pixels. Check effect and escalation in the result.",
    parameters: obj({ target, elementToken: s("token from a fresh observation"), x: n("window x"), y: n("window y"), delivery: s("'background' or 'foreground'"), button: s("'left', 'right', 'middle'"), count: n("click count") }, ["target"]) },
  { name: "double_click", description: "Double-click an element token or window point.", parameters: obj({ target, elementToken: s("token"), x: n("x"), y: n("y"), delivery: s("delivery route") }, ["target"]) },
  { name: "right_click", description: "Right-click an element token or window point to open a context menu.", parameters: obj({ target, elementToken: s("token"), x: n("x"), y: n("y") }, ["target"]) },
  { name: "type_text", description: "Type text into an element or the focused element of a window.",
    parameters: obj({ target, text: s("the text to type"), elementToken: s("token"), x: n("x"), y: n("y"), replace: b("replace the value instead of appending"), delivery: s("delivery route") }, ["target", "text"]) },
  { name: "press_key", description: "Press one named key in the target window.",
    parameters: obj({ target, key: s("key name such as Enter or Escape"), delivery: s("delivery route") }, ["target", "key"]) },
  { name: "hotkey", description: "Press a key chord held together, such as ctrl+shift+t.",
    parameters: obj({ target, keys: { type: "array", items: { type: "string" }, description: "keys to hold, in order" }, delivery: s("delivery route") }, ["target", "keys"]) },
  { name: "scroll", description: "Scroll a window: a wheel at an element or point, or the focused scroller by line or page.",
    parameters: obj({ target, direction: s("'up', 'down', 'left', 'right'"), elementToken: s("token"), x: n("x"), y: n("y"), amount: n("how much"), by: s("'line' or 'page'") }, ["target", "direction"]) },
  { name: "set_value", description: "Set an element's value directly, with no focus and no keystrokes.",
    parameters: obj({ target, elementToken: s("token of the control"), value: s("the value to set") }, ["target", "elementToken", "value"]) },
  { name: "screenshot", description: "Capture one window, or the display when no window is named. An image is thousands of tokens.",
    parameters: obj({ target }) },
  { name: "run_steps", description: "Run several actions in one call with per-step expectations, and observe what changed in the same response.",
    parameters: obj({
      target,
      steps: { type: "array", items: obj({ action: s("click, type_text, press_key, hotkey, scroll, set_value"), elementToken: s("token"), x: n("x"), y: n("y"), text: s("text to type"), key: s("key"), keys: { type: "array", items: { type: "string" } }, expect: s("text or condition the step must produce") }), description: "the actions, in order" },
      observe: b("observe at the end of the batch"),
      foregroundFallback: b("climb to foreground when background input is refused"),
      delayMs: n("wait between steps"),
    }, ["steps"]) },
  { name: "prepare_browser", description: "Attach the browser tools to a driver-owned Chromium with its own persistent profile.",
    parameters: obj({ window: s("browser window id"), profile: s("'isolated', 'isolated_named', 'existing'"), existingProfile: s("profile name to reuse"), allowLaunch: b("may launch a browser") }) },
  { name: "browser_state", description: "Bind to a browser window (target id and tabs), or snapshot a bound tab into typed refs.",
    parameters: obj({ window: s("browser window id"), ...tab, format: s("'markdown' or 'elements'"), query: s("narrow to a subtree"), scopeRef: s("scope ref"), continuation: s("continuation cursor"), screenshot: b("include the image") }) },
  { name: "browser_navigate", description: "Navigate one bound tab to a URL. Invalidates every ref on the tab.",
    parameters: obj({ ...tab, url: s("url to navigate to") }, ["targetId", "tabId", "url"]) },
  { name: "browser_click", description: "Click a page element by ref, or a point in the tab's viewport, over CDP.",
    parameters: obj({ ...tab, ref: s("page ref"), x: n("viewport x"), y: n("viewport y"), inputRoute: s("'trusted' or 'dom_event'") }, ["targetId", "tabId"]) },
  { name: "browser_type", description: "Type into a page element by ref, over CDP.",
    parameters: obj({ ...tab, text: s("text to type"), ref: s("page ref"), replace: b("replace the value"), mode: s("typing mode") }, ["targetId", "tabId", "text"]) },
  { name: "browser_select", description: "Pick one option of a native select on a page without opening its popup.",
    parameters: obj({ ...tab, ref: s("page ref"), value: s("option value") }, ["targetId", "tabId", "ref", "value"]) },
  { name: "browser_pointer", description: "Hover, right-click, double-click, scroll or drag inside a bound tab.",
    parameters: obj({ ...tab, action: s("'hover', 'right_click', 'double_click', 'scroll', 'drag'"), ref: s("page ref"), x: n("x"), y: n("y"), toX: n("drag end x"), toY: n("drag end y") }, ["targetId", "tabId", "action"]) },
  { name: "browser_dialog", description: "Inspect or resolve a page JavaScript dialog: alert, confirm, prompt, beforeunload.",
    parameters: obj({ ...tab, action: s("'inspect', 'accept', 'dismiss'"), dialogId: s("dialog id"), promptText: s("text for a prompt") }, ["targetId", "tabId", "action"]) },
  { name: "read_page", description: "Snapshot a bound tab as real page state, with the challenge state attached and named.",
    parameters: obj({ ...tab, format: s("'markdown' or 'elements'"), query: s("narrow to a subtree"), screenshot: b("include the image") }, ["targetId", "tabId"]) },
  { name: "end_browser_session", description: "Detach the browser tools and end the driver-owned browser session.", parameters: obj({}) },
  { name: "assess_challenge", description: "Decide what to do about a page challenge, cheapest first, and get a token to inject when a solver is the answer.",
    parameters: obj({ page: obj({ url: s("page url"), title: s("page title"), signals: { type: "array", items: { type: "string" } } }), persistentProfile: b("the bot's own profile persists"), solve: b("run the solver if one is configured") }, ["page"]) },
];
