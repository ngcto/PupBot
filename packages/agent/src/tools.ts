import type { ToolSchema } from "@terabot/providers";
import type { RunStreamEvent } from "./events.ts";

/**
 * The tool loop's extension point.
 *
 * The harness was a chat loop with no tool-call handling, so nothing could act on
 * the world. This is the seam every tool surface registers into — the vault's here,
 * the Cua Driver's in its own package — and `executeRun` owns the loop itself, so
 * there is one place that replays calls, runs handlers and re-streams.
 *
 * A handler returns `ToolOutcome`. Note what is *not* in that shape: there is no
 * channel for a value the model must not see. A handler that needs to act on a
 * secret does the acting inside itself — it types the value into a field — and
 * returns a sentence. That is deliberate, not incidental: a tool result is model
 * context by definition, so any field of `ToolOutcome` that carried a credential
 * would put it in the context.
 */

export interface ToolContext {
  workspaceId: string;
  botId: string;
  conversationId: string;
  runId: string;
  /** Cooperative cancellation: a tool that waits must give up when this fires. */
  signal: AbortSignal;
  /** Append a replay event so the UI can show what the bot is doing. */
  emit: (event: RunStreamEvent) => Promise<number>;
}

export interface ToolOutcome {
  /** What the model reads. Never a secret, never a raw provider error. */
  result: string;
  /** True when the run should stop after this step (the tool ended the turn). */
  endRun?: boolean;
}

export interface RunTool {
  schema: ToolSchema;
  handler: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;
}

export type ToolRegistry = Map<string, RunTool>;

export function createToolRegistry(tools: RunTool[] = []): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of tools) registry.set(tool.schema.name, tool);
  return registry;
}

export function schemasOf(registry: ToolRegistry): ToolSchema[] {
  return [...registry.values()].map((tool) => tool.schema);
}

/**
 * A string argument, or the empty string. Models omit optional-looking arguments
 * and send numbers for numeric ones, so this is lenient about type and strict about
 * what it hands back.
 */
export function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** The last step to mention in an error, so a model knows what failed. */
export function summariseToolError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "the tool failed";
}
