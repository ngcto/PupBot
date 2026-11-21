import { codemodeSchema, runCodeMode } from "@terabot/tools";
import type { DispatchableTool } from "@terabot/tools";
import type { RunTool, ToolContext, ToolOutcome } from "./tools.ts";

/**
 * Code mode as one registered tool, built from the run's own registry.
 *
 * **Why this exists.** `@terabot/tools` measured the index at 1,200 tokens against
 * 3,546 for the raw schemas, and shipped `codemodeSchema`/`runCodeMode` to use it —
 * but nothing imported the package, so a hosted run's tool list was only ever the
 * surfaces that registered directly. This is the missing wire: one `codemode` tool
 * that lets a model write a program calling the tools this run already has.
 *
 * **It is derived, not declared.** The index comes from `registry` at the moment the
 * tool is built, so a tool registered later — the Cua Driver's, when `packages/cua`
 * lands — appears in the index with no change here. A hand-written catalogue would
 * have to be kept in step with the registry, and would quietly go stale.
 *
 * **What it deliberately does not do.** It registers no tool of its own beyond
 * `codemode`: the CUA tools belong to `packages/cua` and TERA-74, and the vault's
 * are already in `tools`. So this is the seam, not the catalogues. It also skips the
 * vault's own tools in the index — see `wrappable` below — because a program is not
 * allowed to reach a credential.
 */

/**
 * Tools a program may call.
 *
 * The vault's tools are excluded on purpose. Their safety rests on `ToolOutcome`
 * having no field a secret could travel in, and on the fill path typing a value
 * without returning it. Inside a program, a tool's result is *data the model wrote
 * code to inspect* — `const r = await tools.vault_fill(…)` then `text(r)` — so
 * offering them would rebuild the leak channel the vault's design exists to close.
 * The check is by name rather than by package so it cannot be bypassed by a future
 * wrapper that presents a vault tool under a new interface.
 */
const VAULT_TOOL_PREFIX = "vault_";

function wrappable(registry: Map<string, RunTool>): RunTool[] {
  return [...registry.values()].filter((tool) => !tool.schema.name.startsWith(VAULT_TOOL_PREFIX));
}

/**
 * Turns a `RunTool` into the `DispatchableTool` code mode calls.
 *
 * The `when` list matters more than it looks: a capability search matches how a
 * model describes being stuck, and a schema's description is written for a model
 * choosing among visible tools, not for one searching by situation. Until a tool
 * carries its own `when`, the description and its parameter names are the best
 * honest substitute — and they are what the model saw anyway before this existed.
 */
function asDispatchable(tool: RunTool, context: ToolContext): DispatchableTool {
  const schema = tool.schema.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = schema.required ?? [];
  const properties = Object.keys(schema.properties ?? {});
  return {
    name: tool.schema.name,
    // A tool registered without a description still has to appear in the index; the
    // name is the least misleading stand-in, and an empty line would be worse.
    description: tool.schema.description ?? tool.schema.name,
    // The situations a search can match: what the caller must supply, then what it
    // may. Both are phrased the way a schema names them, which is the only honest
    // vocabulary available until a tool can carry its own `when` list.
    when: required.length > 0 ? required.map((name) => `passes ${name}`) : properties.map((name) => `sets ${name}`),
    category: "data",
    cost: "cheap",
    placement: "anywhere",
    execute: async (input) => {
      const outcome = await tool.handler(input, context);
      // A program gets the sentence the model would have got. It is text on purpose:
      // handing back a typed object would invite a program to treat a tool result as
      // structured data the harness never promised.
      return outcome.result;
    },
  };
}

/**
 * Builds the `codemode` tool for a run.
 *
 * `tools` is the run's full tool list and the registry is rebuilt here, so the index
 * and the handlers cannot disagree. `emit` lets each admitted call reach the run's
 * event log without the model paying for it; it takes no `ToolContext` because the
 * tool is registered once, at the top of the run, while the context that carries
 * `workspaceId` and `emit` only exists per call.
 *
 * The wrapped handlers still need that per-call context — a tool that emits a replay
 * event must be handed the real one — so it is passed through `handler`, which
 * reconstructs it from the `ToolContext` it receives. Nothing is captured from a
 * previous call, and a run that makes three code-mode calls gets three correct
 * contexts rather than one it happened to start with.
 */
export function codemodeTool(tools: RunTool[]): RunTool | null {
  const registry = new Map<string, RunTool>();
  for (const tool of tools) registry.set(tool.schema.name, tool);
  const offered = wrappable(registry);
  if (offered.length === 0) return null;

  // The schema only needs the entries, so it is built once; the dispatchers need the
  // live context, so they are built per call inside the handler.
  const schema = codemodeSchema(
    offered.map((tool) => asDispatchable(tool, placeholderContext)),
  );

  return {
    schema,
    handler: async (input, context): Promise<ToolOutcome> => {
      const code = typeof input.code === "string" ? input.code : "";
      if (code.trim() === "") return { result: "codemode needs a program to run" };

      const dispatchable = offered.map((tool) => asDispatchable(tool, context));
      const { text } = await runCodeMode(
        { code },
        {
          tools: dispatchable,
          signal: context.signal,
          onCall: (record) => {
            // Recorded for the UI, not the model. `CallRecord` carries a name, a
            // success flag and a duration — not the arguments — so the event log
            // cannot become a channel for a value the model never saw.
            void context.emit({
              type: "tool_call",
              payload: { id: `${context.runId}:${record.name}`, name: record.name, status: record.ok ? "done" : "error" },
            });
          },
        },
      );
      return { result: text };
    },
  };
}

/**
 * A context for schema construction only.
 *
 * `codemodeSchema` reads names, descriptions and `when`; it never calls a handler. This
 * stands in so the schema can be built once outside a run's call loop, and it throws
 * if anything ever reaches it, which would mean the schema builder had started
 * describing by behaving.
 */
const placeholderContext: ToolContext = {
  workspaceId: "",
  botId: "",
  conversationId: "",
  runId: "",
  signal: new AbortController().signal,
  emit: async () => {
    throw new Error("a tool handler ran while the codemode schema was being built");
  },
};

/**
 * Whether a run has anything worth wrapping.
 *
 * A run whose only tools are the vault's gets no `codemode`: a program that can call
 * nothing is a prompt surface that costs tokens and buys nothing, and the model would
 * be invited to write code that can only fail.
 */
export function codemodeApplies(tools: RunTool[]): boolean {
  const registry = new Map<string, RunTool>();
  for (const tool of tools) registry.set(tool.schema.name, tool);
  return wrappable(registry).length > 0;
}

/** The name a run's own tool carries when it is already code mode. */
export const CODEMODE_NAME = "codemode";

/**
 * Whether this run is already code mode, so wrapping it again would be a second shell.
 *
 * A caller that hands in its own `codemode` — a benchmark arm, or any surface that
 * wants to choose its own disclosure — has already made the tools reachable from a
 * program. Wrapping it again does not add a layer a model can use: the registry keys
 * by name, so the two `codemode` entries collapse into one, and the schema that
 * survives is whichever the registry was given last. The model then gets a `codemode`
 * whose index lists exactly one tool, `codemode`, and every honest name it tries
 * comes back `there is no tool called "listWindows"`.
 *
 * That is not a hypothetical. It is what the three code-mode arms were measured
 * through in `reports/tera-81-bench`: `executeRun` wrapped an arm whose single tool was
 * already a program surface, and the model spent its turns being told, correctly, that
 * the capability index contained nothing but a shell. The arm looked like evidence that
 * code mode cannot name a tool; it was evidence that a shell was wrapped in a shell.
 *
 * Detected by name rather than by identity because a caller's tool is built outside
 * this package and shares no prototype with anything here.
 */
export function isCodeMode(tools: RunTool[]): boolean {
  return tools.some((tool) => tool.schema.name === CODEMODE_NAME);
}

