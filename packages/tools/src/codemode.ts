/**
 * The code-mode tool: one tool whose input is a program.
 *
 * The model is given a single tool, `codemode`, whose argument is JavaScript. That
 * program calls `tools.<name>(args)`, which the sandbox dispatches to the host —
 * so a nested call's full result stays in this process and only what the program
 * `text()`s or returns reaches the model. Measured on our own surface
 * (`reports/tera-81-measurements/`): a 10,000-row result is 294,592 tokens through
 * the model and 149 filtered in code, and 26 tool schemas cost 3,546 tokens against
 * 1,877 for this tool: 1,771 of index, 106 of instructions. The header is not free,
 * and the split is measured in `verify-index.mts` rather than assumed.
 *
 * Three properties this file is responsible for, each of which a reviewer should
 * check rather than take on trust:
 *
 * 1. **A tool's structured result goes to the program, not to the model.** A CUA
 *    action answers with `effect`, `escalation` and `refusal`; the program gets all
 *    of it and branches on it in code. Flattening `effect` into a boolean here
 *    would throw away the ladder the CUA package exists to expose, so the value
 *    crosses intact and the model only ever reads what the program chose to print.
 * 2. **Every call passes through one gate.** Placement, the call budget and the
 *    cancellation flag are checked in `dispatch()` and nowhere else, so there is no
 *    path from a program to a handler that skips them.
 * 3. **A failed program still reports what its calls did**, because a model reading
 *    "it timed out" needs to know which three actions had already landed.
 */

import { availableIndex, declarationsFor, namesOf, renderIndex, searchIndex } from "@terabot/tools";
import type { ToolEntry, ToolPlacement } from "@terabot/tools";
import { runProgram } from "@terabot/sandbox";
import type { CallRecord, SandboxResult, SandboxTool, ToolCallContext } from "@terabot/sandbox";

/** A tool the harness can dispatch: what it is, where it runs, and how to run it. */
export interface DispatchableTool extends ToolEntry {
  /** Runs the tool. Only ever called by `dispatch()`. */
  execute(input: Record<string, unknown>, context: ToolCallContext): Promise<unknown>;
}

export interface CodeModeToolInput {
  /** The program the model wrote. */
  code: string;
}

export interface CodeModeOptions {
  tools: DispatchableTool[];
  /** Where the program runs. Filters the index, so a tool that cannot run here is never offered. */
  placement?: ToolPlacement;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
  /**
   * Called for every admitted call, so the run's event log can show what the bot did
   * without the model paying for it.
   */
  onCall?: (record: CallRecord) => void;
}

/**
 * The model-facing schema: 1,877 tokens with the 26-entry index inline, of which
 * 1,771 is index and 106 instructions; 146 with the instructions and no index, for
 * a search-only variant. `verify-index.mts` prices both through a real `tools` block.
 */
export interface CodeModeSchemaOptions {
  /**
   * Whether the capability index travels in the tool description.
   *
   * `inline` (the default) is 1,877 tokens on the 26-entry surface and costs no turn.
   * `lazy` is 146: the index is dropped and a program calls `searchTools` to find what
   * it needs, which costs one call inside the sandbox rather than a model round trip.
   * `names` is 227: the names alone, comma-joined, with no descriptions. It is evidence
   * that a capability exists without saying what it does, which is the smallest thing
   * that might work — `lazy` at 146 failed because the model read a prompt with nothing
   * in it and concluded there was nothing it could do.
   *
   * Measured on the same eleven tasks at three reps, with the full 26-entry surface:
   * **inline 5/11 cells, names 1/11, lazy 1/11.** Names failed because a name does not
   * say how to use it — the model called `listApps` as a top-level tool and got a real
   * refusal. Lazy failed because a model cannot search for what it does not know exists.
   *
   * `inline` is therefore the default. `lazy` and `names` stay constructible because
   * they are the evidence for what the 1,731 tokens buy; a default recorded without its
   * alternatives is a decision nobody can revisit.
   */
  disclosure?: "inline" | "lazy" | "names";
}

export function codemodeSchema(
  tools: ToolEntry[],
  placement: ToolPlacement = "host",
  options: CodeModeSchemaOptions = {},
) {
  const index = availableIndex(tools, placement);
  const instructions = [
    "Run JavaScript that calls tools. Call one as `await tools.<name>(args)`.",
    "Use `text(value)` to show something to the user of this tool, or `return` a value.",
    "Nothing you do not print reaches you: a tool's full result is yours to inspect and filter in code.",
    "Use `await tools.searchTools({ query })` to find a tool by the situation you are in,",
    "and `await tools.describeTool({ name })` for its exact signature.",
  ];
  const description = [
    ...instructions,
    "",
    // Lazy keeps the discovery instructions — which are what make a search-only
    // surface usable — and drops only the index itself.
    ...disclosureLines(index, options.disclosure ?? "inline"),
  ].join("\n");
  return {
    name: "codemode",
    description,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The program body. Top-level `await` and `return` both work.",
        },
      },
      required: ["code"],
    },
  };
}

/**
 * What the schema says about which tools exist.
 *
 * Three answers, each measured or being measured. `inline` lists every tool with what it
 * does; `names` lists the names only; `lazy` lists nothing and points at `searchTools`.
 */
function disclosureLines(index: ToolEntry[], disclosure: "inline" | "lazy" | "names"): string[] {
  if (disclosure === "lazy") {
    return ["The tools available here are listed by `searchTools`; nothing is listed in this prompt."];
  }
  if (disclosure === "names") {
    return ["Available here (call `searchTools` for what each one does):", namesOf(index).join(", ")];
  }
  return ["Available here:", renderIndex(index)];
}

/**
 * The `searchTools` and `describeTool` capabilities, exposed as ordinary tools so a
 * program can discover the rest without the harness adding a second prompt surface.
 */
function discoveryTools(tools: DispatchableTool[], placement: ToolPlacement): DispatchableTool[] {
  const index: ToolEntry[] = availableIndex(tools, placement);

  const search: DispatchableTool = {
    name: "searchTools",
    description: "Find tools by the situation you are in, or by name.",
    when: ["cannot find the right tool", "what can do this", "search capabilities"],
    category: "data",
    cost: "cheap",
    placement: "anywhere",
    execute: async (args) => {
      const query = typeof args.query === "string" ? args.query : "";
      return searchIndex(index, query).map((entry) => ({
        name: entry.name,
        description: entry.description,
        cost: entry.cost,
        when: entry.when,
      }));
    },
  };

  const describe: DispatchableTool = {
    name: "describeTool",
    description: "Get the TypeScript signature of one or more tools, by name.",
    when: ["how do I call it", "what arguments", "exact signature"],
    category: "data",
    cost: "cheap",
    placement: "anywhere",
    execute: async (args) => {
      const names = Array.isArray(args.names)
        ? args.names.filter((name): name is string => typeof name === "string")
        : typeof args.name === "string"
          ? [args.name]
          : [];
      return declarationsFor(index, names);
    },
  };

  return [search, describe];
}

/**
 * Runs the program and renders the result for the model.
 *
 * The returned string is everything the model sees. It deliberately leads with the
 * program's own output rather than with the harness's summary, because that output
 * is what the model asked for; the summary exists to tell it what went wrong or what
 * it did not print.
 */
export async function runCodeMode(
  input: CodeModeToolInput,
  options: CodeModeOptions,
): Promise<{ text: string; result: SandboxResult; calls: CallRecord[] }> {
  const placement = options.placement ?? "host";

  // One list, so the program cannot reach a tool this placement cannot run and the
  // discovery tools go through the same gate as everything else.
  const offered: DispatchableTool[] = [
    ...availableIndex(options.tools, placement),
    ...discoveryTools(options.tools, placement),
  ];
  const sandboxTools: SandboxTool[] = offered.map((entry) => ({
    name: entry.name,
    description: entry.description,
    ...(entry.cost ? { cost: entry.cost } : {}),
    ...(entry.when ? { when: entry.when } : {}),
    execute: (args, context) => dispatch(entry, args, context, options),
  }));

  const result = await runProgram(input.code, sandboxTools, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
    ...(options.maxOutputChars !== undefined ? { maxOutputChars: options.maxOutputChars } : {}),
  });

  for (const record of result.calls) options.onCall?.(record);

  return { text: renderForModel(result), result, calls: result.calls };
}

/**
 * The single enforcement point. Every check a program can trip lives here: the tool
 * has to exist, it has to be allowed where the program is running, the run must not
 * be cancelled, and the sandbox has already counted the call against its budget.
 */
async function dispatch(
  tool: DispatchableTool,
  args: Record<string, unknown>,
  context: ToolCallContext,
  options: CodeModeOptions,
): Promise<unknown> {
  if (context.signal.aborted || options.signal?.aborted) {
    throw new Error("the run was cancelled");
  }
  return tool.execute(args, context);
}

/** Total characters the trace may add, whatever the calls returned. */
export const TRACE_CHARS = 600;
/** Calls shown, newest last: the ones a model is about to debug against. */
export const TRACE_CALLS = 3;

/**
 * What the program's last calls returned.
 *
 * Deliberately says what was called and what came back, and nothing about why the
 * program failed — the model already knows it printed nothing. Each preview is
 * truncated by the sandbox before it crosses, and the whole trace is capped again
 * here, so a program that read a large result cannot return it through the trace.
 */
export function traceFor(result: SandboxResult): string | undefined {
  const withPreview = result.calls.filter((call) => call.preview !== undefined && call.preview !== "");
  if (withPreview.length === 0) return undefined;

  const shown = withPreview.slice(-TRACE_CALLS);
  const omitted = withPreview.length - shown.length;
  const head = omitted > 0 ? [`What your last ${shown.length} calls returned (${omitted} earlier omitted):`] : ["What your calls returned:"];

  let used = 0;
  const lines = [...head];
  for (const call of shown) {
    const mark = call.ok ? "" : " [failed]";
    const cut = call.truncated ? " [truncated]" : "";
    const line = `- ${call.name}${mark}: ${call.preview}${cut}`;
    if (used + line.length > TRACE_CHARS) {
      lines.push("- (trace cut at its limit)");
      break;
    }
    used += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * What the model reads.
 *
 * Order matters: the program's output first, because that is the answer it asked
 * for; then a line naming the failure; then the call log, which is the only way the
 * model can tell "it did nothing" from "it did three things and stopped".
 */
export function renderForModel(result: SandboxResult): string {
  const lines: string[] = [];

  for (const item of result.output) lines.push(item);
  // Whether the *program* produced something, which is not the same as whether
  // `lines` is empty by the time the fallback "printed nothing" message is added.
  const printed = result.output.length > 0 || (result.ok && result.value !== undefined && result.value !== null);

  if (!result.ok) {
    const where = result.error.line !== undefined ? ` (line ${result.error.line})` : "";
    lines.push(`The program stopped: ${result.error.message}${where}`);
    if (result.error.kind === "stall") {
      lines.push(
        "That is a program error, not a slow tool: the sandbox has no timers, so a promise nothing resolves can never settle.",
      );
    }
    if (result.error.kind === "limit") {
      lines.push("Write a smaller program, or filter more in code before printing.");
    }
  } else if (result.value !== undefined && result.value !== null) {
    lines.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value));
  }

  if (lines.length === 0) {
    lines.push(
      result.ok
        ? "The program finished and printed nothing. If it was meant to report something, call text(...) or return it."
        : "The program failed without printing anything.",
    );
  }

  // The trace: only when the program printed nothing or failed. A successful program
  // that printed its answer gets no trace at all, because a trace on success is how a
  // code-mode surface quietly doubles its token cost.
  if (!printed || !result.ok) {
    const trace = traceFor(result);
    if (trace) lines.push(trace);
  }

  if (result.calls.length > 0) {
    const failed = result.calls.filter((call) => !call.ok);
    const summary = failed.length === 0
      ? `${result.calls.length} tool call${result.calls.length === 1 ? "" : "s"} succeeded.`
      : `${result.calls.length} tool call${result.calls.length === 1 ? "" : "s"}, ${failed.length} failed (${failed.map((call) => call.name).join(", ")}).`;
    lines.push(`[${summary} ${Math.round(result.ms)} ms in the sandbox; tool time is not shown because it is not what you pay for.]`);
  }

  return lines.join("\n");
}
