/**
 * The code-mode sandbox: model-written JavaScript runs in a QuickJS VM compiled
 * to WebAssembly, and its only capability is calling the tools the host injects.
 *
 * Two properties this file exists to provide, both of which the harness above it
 * depends on:
 *
 * 1. **Nested tool calls never enter the model's context.** The VM's output is
 *    what `text()`/`image()` appended plus the script's return value; a tool's
 *    full result stays in the host. That is the whole token argument, so it is
 *    enforced here rather than by convention at the call site.
 * 2. **The VM has no ambient capability.** It runs in a worker thread with no
 *    timers, no `fetch`, no `process`, no `require`, no modules and no
 *    `WebAssembly` — not by policy, but because nothing is registered. Measured:
 *    all five are `undefined` inside.
 *
 * A script that awaits a promise nothing can settle fails immediately instead of
 * hanging. The VM has no timers and no I/O, so "the program is waiting for
 * something that can never arrive" is detectable, and it is a different failure
 * from a timeout: it means the program is wrong, not that it was slow.
 */

/** What the VM is told about a tool: everything except how to run it. */
export type SandboxMeta = Omit<SandboxTool, "execute">;

export interface SandboxTool {
  /** The identifier the script calls: `tools.<name>(args)`. */
  name: string;
  description: string;
  /** One phrase on what the call costs, shown in the index. */
  cost?: "cheap" | "moderate" | "expensive";
  /**
   * Situation phrases a capability search matches, so discovery works from what
   * the model is stuck on ("the page is gated and clicks do nothing") rather than
   * from a verb it guessed.
   */
  when?: string[];
  execute: (args: Record<string, unknown>, context: ToolCallContext) => Promise<unknown>;
}

export interface ToolCallContext {
  /** The ordinal of this call within the execution, from 0. */
  index: number;
  signal: AbortSignal;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Wall-clock cap for the whole execution, in milliseconds. */
  timeoutMs?: number;
  /** A ceiling on calls, so a flailing program cannot bill forever. */
  maxToolCalls?: number;
  /** Cap on retained text output, in characters. */
  maxOutputChars?: number;
  /** The VM's heap cap, in bytes. */
  memoryBytes?: number;
}

export type SandboxErrorKind =
  | "script"
  | "timeout"
  | "aborted"
  | "limit"
  | "stall"
  | "sandbox";

export interface SandboxFailure {
  kind: SandboxErrorKind;
  message: string;
  /** A line the model can correct against, when the engine reported one. */
  line?: number;
  stack?: string;
}

export interface CallRecord {
  name: string;
  /** True when the tool resolved, false when it threw or was refused. */
  ok: boolean;
  /** Milliseconds the host spent in the tool, which the model never sees. */
  ms: number;
}

export type SandboxResult =
  | { ok: true; output: string[]; value: unknown; calls: CallRecord[]; ms: number }
  | { ok: false; error: SandboxFailure; output: string[]; calls: CallRecord[]; ms: number };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_CALLS = 24;
export const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
export const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;

/**
 * Tool names are exposed as identifiers, so `my-tool` is reachable as
 * `tools.my_tool` as well as `tools["my-tool"]`. Characters that cannot be part
 * of an identifier become `_`.
 */
export function toIdentifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

/**
 * The script environment. Kept as a string because it must be evaluated inside
 * the VM, and building it from the host means a tool name can never inject code
 * — it is JSON, not interpolation.
 */
export function preludeFor(tools: SandboxMeta[]): string {
  const assignments = tools
    .map((tool) => {
      const id = toIdentifier(tool.name);
      return `  ${id}: (args) => __call(${JSON.stringify(tool.name)}, args),`;
    })
    .join("\n");

  return `
"use strict";
globalThis.text = (value) => {
  __out.push(typeof value === "string" ? value : JSON.stringify(value));
};
globalThis.ALL_TOOLS = ${JSON.stringify(
    tools.map((tool) => ({
      name: toIdentifier(tool.name),
      description: tool.description,
      ...(tool.cost ? { cost: tool.cost } : {}),
      ...(tool.when ? { when: tool.when } : {}),
    })),
  )};
globalThis.tools = new Proxy(
  {
${assignments}
  },
  {
    // A name the program invented still reaches the host, so the answer is
    // "there is no tool called X" rather than "undefined is not a function" —
    // the first tells the model what to fix, the second tells it nothing.
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "then" || key === "toJSON") return undefined;
      return (args) => __call(key, args);
    },
  },
);
`;
}

/** Wraps the model's source as an async function body, so `return` and top-level `await` work. */
export function programOf(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

/**
 * Parses `at <name> (<file>:<line>:<col>)` out of a QuickJS stack, so a syntax or
 * runtime error can be reported against the line the model wrote. The wrapper
 * adds one line, which is subtracted here.
 */
export function lineFromStack(stack: string | undefined): number | undefined {
  if (!stack) return undefined;
  const match = /<eval>:(\d+):/.exec(stack) ?? /codemode\.js:(\d+):/.exec(stack);
  if (!match?.[1]) return undefined;
  const line = Number.parseInt(match[1], 10) - 1;
  return line > 0 ? line : undefined;
}
