/**
 * The three arms, built from one fixture corpus.
 *
 * The arms differ in exactly one thing: how a tool reaches the model. Everything
 * else — system prompt, task text, gateway, step cap, fixture state — is identical,
 * which is what makes a difference between columns attributable to the surface.
 *
 *   A  no tools at all, the harness as it ships on `main` before this work.
 *   B  the 26 tools as native schemas, called one model turn at a time.
 *   C  one `codemode` tool whose program calls the same 26 in a sandbox.
 */

import { codemodeSchema, runCodeMode } from "@terabot/tools";
import type { DispatchableTool, ToolCategory } from "@terabot/tools";
import type { ToolSchema } from "@terabot/providers";
import type { RunTool, ToolContext } from "../tools.ts";
import { fixtureImplementations, freshWorld, treeFor, WINDOWS } from "./fixtures.ts";
import type { WorldState } from "./fixtures.ts";

/**
 * `d` is code mode with the index dropped and discovery by `searchTools`.
 *
 * It exists as a separate arm rather than a replacement for `c` so the inline and lazy
 * surfaces are measured side by side on the same tasks, against the same B numbers.
 * Reporting only the lazy variant would lose the evidence that laziness helps.
 */
export type Arm = "a" | "b" | "c" | "d" | "e";

/**
 * The token task 9 asks for, which the fixture refuses once.
 *
 * Exported so the task text and the fixture cannot drift apart: a task that names a
 * token the fixture does not refuse is unanswerable, and nobody would notice from a
 * pass/fail column alone.
 */
export const STALE_TOKEN = "t1x7";

export interface ArmBuild {
  arm: Arm;
  tools: RunTool[];
  /** The same state the tools mutate, so a task can assert on what actually changed. */
  world: WorldState;
  /** Calls made, in order, for the transcript and the validator. */
  log: Array<{ name: string; input: Record<string, unknown>; effect?: string }>;
}

/**
 * The tool entries every arm's *model-facing* surface is built from.
 *
 * These carry the index metadata the report's 26 entries carry — `when`, `cost`,
 * `description` — because the token cost of arm B is the cost of these schemas and
 * the cost of arm C is the cost of this index. Trimming them would make both arms
 * look cheaper than the thing they are standing in for.
 */
const ENTRIES: Array<{
  name: string;
  description: string;
  cost: "cheap" | "moderate" | "expensive";
  when: string[];
  category: ToolCategory;
  parameters: Record<string, unknown>;
}> = [
  { name: "listWindows", description: "List the open windows on the computer.", cost: "cheap", when: ["which windows exist", "what is open"], category: "observe", parameters: { type: "object", properties: {}, required: [] } },
  { name: "listApps", description: "List the GUI apps running on the computer.", cost: "cheap", when: ["is an app running", "which apps are open"], category: "observe", parameters: { type: "object", properties: {}, required: [] } },
  { name: "launchApp", description: "Start an app in the background and return the windows it opened.", cost: "moderate", when: ["open an app", "the app is not running"], category: "act", parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "observeWindow", description: "Read one window: its accessibility tree, as structured rows and a compact outline.", cost: "cheap", when: ["what is in a window", "before acting in a window"], category: "observe", parameters: { type: "object", properties: { windowId: { type: "string" }, screenshot: { type: "boolean" } }, required: ["windowId"] } },
  { name: "observeDesktop", description: "Read the whole display, including its screenshot.", cost: "expensive", when: ["nothing is observable by window"], category: "observe", parameters: { type: "object", properties: {}, required: [] } },
  { name: "click", description: "Click one exact target: an element token from a fresh observation, or a point.", cost: "cheap", when: ["press a button", "follow a link", "toggle a checkbox"], category: "act", parameters: { type: "object", properties: { token: { type: "string" }, point: { type: "object" } }, required: [] } },
  { name: "doubleClick", description: "Double-click an element token or window point.", cost: "cheap", when: ["open an item in a list"], category: "act", parameters: { type: "object", properties: { token: { type: "string" } }, required: [] } },
  { name: "rightClick", description: "Right-click an element token or window point to open a context menu.", cost: "cheap", when: ["open a context menu"], category: "act", parameters: { type: "object", properties: { token: { type: "string" } }, required: [] } },
  { name: "typeText", description: "Type text into a field, by element token or into the window's focused field.", cost: "cheap", when: ["fill a field", "enter text"], category: "act", parameters: { type: "object", properties: { token: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
  { name: "pressKey", description: "Press one named key in the target window.", cost: "cheap", when: ["submit with enter", "move focus with tab"], category: "act", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "hotkey", description: "Press a key chord held together.", cost: "cheap", when: ["save with a shortcut", "switch tabs"], category: "act", parameters: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"] } },
  { name: "scroll", description: "Scroll a window: a wheel at an element or point, or the focused scroller.", cost: "cheap", when: ["more content below"], category: "act", parameters: { type: "object", properties: { windowId: { type: "string" }, direction: { type: "string" } }, required: [] } },
  { name: "setValue", description: "Set an element's value directly, with no focus and no keystrokes.", cost: "cheap", when: ["a field has a value already", "typing would be slow"], category: "act", parameters: { type: "object", properties: { token: { type: "string" }, value: { type: "string" } }, required: ["token", "value"] } },
  { name: "screenshot", description: "Capture one window, or the display when no window is named.", cost: "expensive", when: ["the tree is insufficient"], category: "observe", parameters: { type: "object", properties: { windowId: { type: "string" } }, required: [] } },
  { name: "runSteps", description: "Run several actions in one call, with per-step expectations, and observe what changed.", cost: "cheap", when: ["do several clicks in a row", "a sequence of similar actions"], category: "act", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "object" } } }, required: ["steps"] } },
  { name: "prepareBrowser", description: "Attach the browser tools to a browser.", cost: "moderate", when: ["browser tools are not attached"], category: "browser", parameters: { type: "object", properties: {}, required: [] } },
  { name: "browserState", description: "Bind to a browser window, or snapshot a bound tab.", cost: "cheap", when: ["which tabs are open"], category: "browser", parameters: { type: "object", properties: {}, required: [] } },
  { name: "browserNavigate", description: "Navigate one bound tab to a URL.", cost: "moderate", when: ["go to a page"], category: "browser", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "readPage", description: "Snapshot a bound tab as real page state, with the challenge state attached and named.", cost: "cheap", when: ["what is on the page", "whether a challenge gates it"], category: "observe", parameters: { type: "object", properties: { url: { type: "string" } }, required: [] } },
  { name: "browserClick", description: "Click a page element by ref, or a point in the tab's viewport, over CDP.", cost: "cheap", when: ["press a page button"], category: "browser", parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "browserType", description: "Type into a page element by ref, over CDP.", cost: "cheap", when: ["fill a page field"], category: "browser", parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] } },
  { name: "browserSelect", description: "Pick one option of a native select on a page without opening its popup.", cost: "cheap", when: ["choose from a dropdown"], category: "browser", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
  { name: "browserPointer", description: "Hover, right-click, double-click, scroll or drag inside a bound tab.", cost: "cheap", when: ["hover for a tooltip", "drag an element"], category: "browser", parameters: { type: "object", properties: { ref: { type: "string" }, action: { type: "string" } }, required: ["ref"] } },
  { name: "browserDialog", description: "Inspect or resolve a page JavaScript dialog: alert, confirm, prompt.", cost: "cheap", when: ["a dialog is blocking the page"], category: "browser", parameters: { type: "object", properties: { action: { type: "string" } }, required: [] } },
  { name: "assessChallenge", description: "Decide what to do about a page challenge, in cheapest-first order.", cost: "moderate", when: ["the page is gated and clicks do nothing"], category: "challenge", parameters: { type: "object", properties: {}, required: [] } },
  { name: "detectCaptcha", description: "Answer whether a page is gated by a challenge, and by which.", cost: "cheap", when: ["is this a captcha"], category: "challenge", parameters: { type: "object", properties: {}, required: [] } },
];

/**
 * Arm A: the harness as it ships, with nothing to call.
 *
 * The loop is the same code; `tools` is empty, so `schemasOf(registry)` is empty and
 * the request carries no tools block. This is not a strawman — it is what every run
 * on `main` before this work looked like.
 */
export function armA(): ArmBuild {
  return { arm: "a", tools: [], world: freshWorld(), log: [] };
}

/**
 * Arm B: the 26 as native schemas.
 *
 * Each call is one model turn: the model names a tool, the harness runs it, the
 * result is replayed as a message, and the model reads it. That is the shape whose
 * cost the report measured at 3,546 tokens of schemas per request.
 */
export function armB(): ArmBuild {
  const world = freshWorld();
  // Task 9 asks the model to click a token that refuses and then recover. Without
  // this the refusal never happens and the task is unanswerable by construction —
  // which is what the first measurement run showed, in both arms, before it was
  // caught. It is a fixture fact, identical in every arm, not a hint to the model.
  world.staleToken = STALE_TOKEN;
  const impl = fixtureImplementations(world);
  const log: ArmBuild["log"] = [];

  const tools: RunTool[] = ENTRIES.map((entry) => ({
    schema: {
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
    } satisfies ToolSchema,
    handler: async (input) => {
      const run = impl[entry.name];
      if (!run) return { result: `there is no tool called "${entry.name}"` };
      const result = run(input);
      log.push({ name: entry.name, input, effect: (result as { effect?: string }).effect });
      return { result: stringify(result) };
    },
  }));

  return { arm: "b", tools, world, log };
}

/**
 * Arm C: one tool whose argument is a program.
 *
 * The handler builds the 26 as `DispatchableTool`s over the *same* implementations
 * and calls `runCodeMode`. What reaches the model is the program's `text()` output
 * and return value — nothing else, which is the whole claim.
 */
export function armC(): ArmBuild {
  return codeModeArm("c", "inline");
}

/** Arm D: the same 26, discovered rather than listed. */
export function armD(): ArmBuild {
  return codeModeArm("d", "lazy");
}

/** Arm E: the names only — evidence that a capability exists, without what it does. */
export function armE(): ArmBuild {
  return codeModeArm("e", "names");
}

function codeModeArm(arm: "c" | "d" | "e", disclosure: "inline" | "lazy" | "names"): ArmBuild {
  const world = freshWorld();
  world.staleToken = STALE_TOKEN;
  const impl = fixtureImplementations(world);
  const log: ArmBuild["log"] = [];

  const dispatchable: DispatchableTool[] = ENTRIES.map((entry) => ({
    name: entry.name,
    description: entry.description,
    when: entry.when,
    cost: entry.cost,
    category: entry.category,
    execute: async (input) => {
      const run = impl[entry.name];
      if (!run) throw new Error(`there is no tool called ${entry.name}`);
      const result = run(input);
      log.push({ name: entry.name, input, effect: (result as { effect?: string }).effect });
      return result;
    },
  }));

  const schema = codemodeSchema(dispatchable, "host", { disclosure });
  const tool: RunTool = {
    schema: { name: schema.name, description: schema.description, parameters: schema.parameters },
    handler: async (input, context: ToolContext) => {
      const code = typeof input.code === "string" ? input.code : "";
      if (!code) return { result: "no program was sent" };
      const outcome = await runCodeMode(
        { code },
        { tools: dispatchable, signal: context.signal },
      );
      return { result: outcome.text };
    },
  };

  return { arm, tools: [tool], world, log };
}

export function buildArm(arm: Arm): ArmBuild {
  if (arm === "a") return armA();
  if (arm === "b") return armB();
  if (arm === "d") return armD();
  if (arm === "e") return armE();
  return armC();
}

/**
 * A result as the model would read it.
 *
 * JSON, and deliberately not compressed: arm B's result cost is the cost of the
 * result shape the real handler would return, and prettifying it here would make
 * arm B look cheaper than it is. Arm C is where filtering happens, and it happens in
 * the program rather than in this function.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value);
}

/** The tools a task names, for the design table and for checking a task is attemptable. */
export function availableToolNames(arm: Arm): string[] {
  if (arm === "a") return [];
  if (arm === "b") return ENTRIES.map((e) => e.name);
  return [codemodeSchema(ENTRIES as never, "host").name];
}

export { ENTRIES, treeFor, WINDOWS };
