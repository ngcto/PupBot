/**
 * The tool index: what a model should know about each function, and what makes
 * it findable by capability rather than by name.
 *
 * This file is **data about the functions, not a schema for a model call**. The
 * harness decides how a call is shaped (a schema, a code-mode invocation, both);
 * it does not have to invent a second description of what the tool does, and
 * changing how the harness exposes a tool must never require editing this file.
 *
 * Two rules shaped the entries:
 *
 * - **`when`, not just `what`.** A capability search needs the situation ("the
 *   page is gated and clicks do nothing"), because that is how a model
 *   describes what it is stuck on.
 * - **Cost is stated.** `cost` says whether a call is cheap enough to use
 *   freely (a tree read, a batch) or expensive enough to think about first (an
 *   image, a solver round trip). That is the difference between a run that
 *   thinks and a run that photographs its way to the budget.
 */

export interface ToolIndexEntry {
  /** The function's name, matching the export in this package. */
  name: string;
  /** One line, present tense, for a tool list. */
  description: string;
  /** Situation phrases a capability search matches against. */
  when: string[];
  /** Broad grouping, for a tool list that is rendered by section. */
  category: "observe" | "act" | "browser" | "challenge";
  /** rough cost of one call: how much of a budget it eats. */
  cost: "cheap" | "moderate" | "expensive";
  /**
   * What the result contains that a caller must not ignore, in one phrase —
   * the ladder fields, the challenge state, and so on.
   */
  resultNote?: string;
}

export const TOOL_INDEX: ToolIndexEntry[] = [
  {
    name: "listWindows",
    description: "List the open windows on the computer, with their pid, window id, app and title.",
    when: ["which windows exist", "find an app's window", "what is open", "before observing a window"],
    category: "observe",
    cost: "cheap",
    resultNote: "the highest z-index is the frontmost window; null means stacking is unknown",
  },
  {
    name: "listApps",
    description: "List the GUI apps running on the computer.",
    when: ["is an app running", "which apps are open", "find what to launch"],
    category: "observe",
    cost: "cheap",
  },
  {
    name: "launchApp",
    description: "Start an app in the background without raising its window, and return the windows it opened.",
    when: ["open an app", "start a program", "the app is not running"],
    category: "act",
    cost: "moderate",
    resultNote: "returns the windows immediately, so no polling is needed",
  },
  {
    name: "observeWindow",
    description: "Read one window: its accessibility tree, as structured rows and a compact outline, plus a snapshot id.",
    when: [
      "look at a window",
      "what is on screen",
      "find a button or field",
      "before acting on an element",
      "re-observe after a stale token",
    ],
    category: "observe",
    cost: "cheap",
    resultNote:
      "pass screenshot:true only when the tree is insufficient; degraded:true means nothing actionable was found, so act on the image in this same result",
  },
  {
    name: "observeDesktop",
    description: "Read the whole display, including its screenshot, for surfaces with no window or tree.",
    when: ["screen coordinates", "whole desktop", "nothing has a window", "where is the pointer"],
    category: "observe",
    cost: "expensive",
    resultNote: "desktop-scope actions use these coordinates",
  },
  {
    name: "click",
    description: "Click one exact target: an element token from a fresh observation, or window pixels.",
    when: ["press a button", "choose a menu item", "follow a link", "select a row"],
    category: "act",
    cost: "cheap",
    resultNote:
      "check effect and escalation: refused with background_unavailable means retry that one action with delivery:'foreground'; stale_element_token means observe again",
  },
  {
    name: "doubleClick",
    description: "Double-click an element token or window point.",
    when: ["open a file", "open a list item", "double click"],
    category: "act",
    cost: "cheap",
    resultNote: "same ladder fields as click",
  },
  {
    name: "rightClick",
    description: "Right-click an element token or window point to open a context menu.",
    when: ["context menu", "right click", "open the menu on a file"],
    category: "act",
    cost: "cheap",
    resultNote: "a menu opens as a popup: observe again to get its rows",
  },
  {
    name: "typeText",
    description: "Type text into a field, by element token or into the window's focused element.",
    when: ["fill a field", "enter text", "type into a search box", "write into a form"],
    category: "act",
    cost: "cheap",
    resultNote:
      "Chromium and Electron inputs need pixel delivery or an element token; unverifiable means the app may have echoed a write it did not apply, so re-observe",
  },
  {
    name: "pressKey",
    description: "Press one named key in the target window.",
    when: ["press enter", "press escape", "tab to the next field", "confirm a dialog"],
    category: "act",
    cost: "cheap",
  },
  {
    name: "hotkey",
    description: "Press a key chord held together, such as ctrl+shift+t or ctrl+s.",
    when: ["keyboard shortcut", "save with ctrl s", "open the address bar", "new tab"],
    category: "act",
    cost: "cheap",
  },
  {
    name: "scroll",
    description: "Scroll a window: a wheel at an element or point, or the focused scroller by line or page.",
    when: ["scroll down", "reveal more content", "reach an off-screen element", "scroll inside a panel"],
    category: "act",
    cost: "cheap",
    resultNote: "targeted wheel scrolls nested overflow regions; Electron drops background wheel events, so use foreground there",
  },
  {
    name: "setValue",
    description: "Set an element's value directly, with no focus and no keystrokes.",
    when: ["set a field value", "fill a text input exactly", "replace a value"],
    category: "act",
    cost: "cheap",
    resultNote: "prefer this over typing when the control exposes an editable value",
  },
  {
    name: "screenshot",
    description: "Capture one window, or the display when no window is named.",
    when: ["see the screen", "look at it", "the tree is empty", "confirm visually"],
    category: "observe",
    cost: "expensive",
    resultNote: "an image is thousands of tokens; read the tree first and take one only when text cannot answer",
  },
  {
    name: "runSteps",
    description: "Run several actions in one call, with per-step expectations, and observe what changed in the same response.",
    when: [
      "fill a form",
      "do several clicks in a row",
      "act and check in one go",
      "type then submit then confirm",
      "more than one action",
    ],
    category: "act",
    cost: "cheap",
    resultNote:
      "one call instead of N model steps; expect checks fail the step loudly instead of three calls that each look fine; a stale token is retried once against the same role and label",
  },
  {
    name: "prepareBrowser",
    description: "Attach the browser tools to a browser, launching an isolated driver-owned Chromium with its own persistent profile.",
    when: [
      "use a web page",
      "open a site",
      "browser is not attached",
      "browser_requires_setup",
      "keep me signed in between runs",
    ],
    category: "browser",
    cost: "moderate",
    resultNote:
      "profile:'isolated_named' keeps cookies and logins across runs, which is what stops a repeat challenge; the person's own browser is never touched",
  },
  {
    name: "browserState",
    description: "Bind to a browser window (target id and tabs), or snapshot a bound tab into typed refs.",
    when: ["which tab", "snapshot the page", "find a link or button on a page", "page refs"],
    category: "browser",
    cost: "cheap",
    resultNote: "mutation needs bindingQuality 'exact'; refs die on the next snapshot or navigation",
  },
  {
    name: "browserNavigate",
    description: "Navigate one bound tab to a URL.",
    when: ["go to a site", "open a url", "navigate"],
    category: "browser",
    cost: "moderate",
    resultNote: "invalidates every ref on the tab",
  },
  {
    name: "readPage",
    description: "Snapshot a bound tab as real page state, with the challenge state attached and named.",
    when: [
      "read a page",
      "what does the page say",
      "extract something from a rendered page",
      "why do my clicks do nothing",
      "is this page gated",
    ],
    category: "observe",
    cost: "cheap",
    resultNote:
      "captcha.gated says whether a challenge is blocking the page and which; that is state, not a failure, and clicks on a gated page cannot work",
  },
  {
    name: "browserClick",
    description: "Click a page element by ref, or a point in the tab's viewport, over CDP.",
    when: ["click a link on a page", "press a page button", "submit a form"],
    category: "browser",
    cost: "cheap",
    resultNote:
      "on Linux trusted input raises the browser and refuses with browser_input_trust_unavailable; inputRoute 'dom_event' stays in the background and reports unverifiable",
  },
  {
    name: "browserType",
    description: "Type into a page element by ref, over CDP.",
    when: ["type on a page", "fill a web form", "search on a site"],
    category: "browser",
    cost: "cheap",
  },
  {
    name: "browserSelect",
    description: "Pick one option of a native select on a page without opening its popup.",
    when: ["choose from a dropdown", "select an option on a page"],
    category: "browser",
    cost: "cheap",
  },
  {
    name: "browserPointer",
    description: "Hover, right-click, double-click, scroll or drag inside a bound tab.",
    when: ["hover a page element", "scroll a page", "drag on a page", "right click on a page"],
    category: "browser",
    cost: "cheap",
  },
  {
    name: "browserDialog",
    description: "Inspect or resolve a page JavaScript dialog: alert, confirm, prompt, beforeunload.",
    when: ["dialog is blocking", "accept a confirm", "dismiss an alert", "beforeunload"],
    category: "browser",
    cost: "cheap",
  },
  {
    name: "assessChallenge",
    description: "Decide what to do about a page challenge, in cheapest-first order, and get a token to inject when a solver is the answer.",
    when: [
      "captcha",
      "the page is gated",
      "clicks do not work",
      "verify you are human",
      "just a moment",
      "security check",
      "stuck on a challenge",
    ],
    category: "challenge",
    cost: "moderate",
    resultNote:
      "paths lists every rung available now in order; injectScript installs a solved token in the page; passed is always false because clearing the gate is proven by re-reading the page, not by this call",
  },
  {
    name: "detectCaptcha",
    description: "Answer whether a page is gated by a challenge, and by which, from what the page already exposes.",
    when: ["is this a captcha", "which captcha", "why is this page different", "no network round trip"],
    category: "challenge",
    cost: "cheap",
    resultNote: "pure function of page state, so it costs nothing and cannot itself trip a heuristic",
  },
];

/** Entries matching a capability phrase, best first. */
export function findTools(query: string): ToolIndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return TOOL_INDEX;
  const scored = TOOL_INDEX.map((entry) => {
    const haystack = [entry.name, entry.description, ...entry.when, entry.category]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += 1;
      if (entry.when.some((phrase) => phrase.includes(word))) score += 2;
      if (entry.name.toLowerCase().includes(word)) score += 3;
    }
    // A tool described for the whole situation beats a tool that only matched
    // the verb: "fill a form" belongs to the batch, not to typing one field.
    if (words.length > 1 && entry.when.some((phrase) => words.every((word) => phrase.includes(word)))) {
      score += 5;
    }
    return { entry, score };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry);
}
