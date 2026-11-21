import type { ToolCall, ToolSchema } from "./types.ts";

/**
 * One place for tool schemas. Our `ToolSchema` is canonical; each wire format
 * gets a converter in and out so a tool defined once works on every endpoint.
 */

const EMPTY_PARAMETERS: Record<string, unknown> = { type: "object", properties: {} };

/**
 * A tool with no parameters must still carry a valid empty-object schema; some
 * providers reject a missing `parameters`/`input_schema` outright.
 */
export function canonicalToolSchema(tool: ToolSchema): ToolSchema {
  const parameters =
    tool.parameters && Object.keys(tool.parameters).length > 0
      ? tool.parameters.type
        ? tool.parameters
        : { type: "object", ...tool.parameters }
      : { type: "object", properties: {} };

  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters,
  };
}

export function canonicalToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
  return (tools ?? []).map(canonicalToolSchema);
}

/* ───────────────────────── OpenAI chat completions ───────────────────────── */

export interface OpenAiChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export function toOpenAiChatTools(tools: ToolSchema[] | undefined): OpenAiChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return canonicalToolSchemas(tools).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

export function toolSchemaFromOpenAiChat(tool: OpenAiChatTool): ToolSchema {
  return canonicalToolSchema({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters ?? {},
  });
}

/* ───────────────────────────── OpenAI responses ──────────────────────────── */

export interface OpenAiResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export function toOpenAiResponsesTools(tools: ToolSchema[] | undefined): OpenAiResponsesTool[] | undefined {
  if (!tools?.length) return undefined;
  return canonicalToolSchemas(tools).map((tool) => ({
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }));
}

export function toolSchemaFromOpenAiResponses(tool: OpenAiResponsesTool): ToolSchema {
  return canonicalToolSchema({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters ?? {},
  });
}

/* ──────────────────────────── Anthropic messages ─────────────────────────── */

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export function toAnthropicTools(tools: ToolSchema[] | undefined): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  return canonicalToolSchemas(tools).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }));
}

export function toolSchemaFromAnthropic(tool: AnthropicTool): ToolSchema {
  return canonicalToolSchema({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema ?? {},
  });
}

/* ───────────────────────────── arguments back ───────────────────────────── */

export type ParsedArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Tool arguments arrive as a JSON string. Models emit `""` or whitespace for a
 * no-argument tool, which means "no arguments", not a parse failure.
 */
export function parseToolArguments(raw: string): ParsedArguments {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null) return { ok: true, value: {} };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "tool arguments must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "tool arguments are not valid JSON" };
  }
}

export function toolCallFromOpenAiChat(call: {
  id?: string;
  function?: { name?: string; arguments?: string };
}): ToolCall {
  return {
    id: call.id ?? "call_0",
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "",
  };
}

export function toolCallFromOpenAiResponses(item: {
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}): ToolCall {
  return {
    id: item.call_id ?? item.id ?? "call_0",
    name: item.name ?? "",
    arguments: item.arguments ?? "",
  };
}

export function toolCallFromAnthropic(block: {
  id?: string;
  name?: string;
  input?: unknown;
}): ToolCall {
  return {
    id: block.id ?? "call_0",
    name: block.name ?? "",
    arguments: block.input === undefined ? "{}" : JSON.stringify(block.input),
  };
}
