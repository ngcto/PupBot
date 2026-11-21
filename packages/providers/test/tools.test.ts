import { describe, expect, it } from "vitest";
import {
  canonicalToolSchema,
  parseToolArguments,
  toAnthropicTools,
  toOpenAiChatTools,
  toOpenAiResponsesTools,
  toolCallFromAnthropic,
  toolCallFromOpenAiChat,
  toolCallFromOpenAiResponses,
  toolSchemaFromAnthropic,
  toolSchemaFromOpenAiChat,
  toolSchemaFromOpenAiResponses,
} from "../src/tools.ts";
import type { ToolSchema } from "../src/types.ts";

const emptyTool: ToolSchema = { name: "get_time", description: "current time", parameters: {} };

const nestedTool: ToolSchema = {
  name: "create_note",
  description: "create a note",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      meta: {
        type: "object",
        properties: { pinned: { type: "boolean" }, order: { type: "number" } },
        required: ["pinned"],
      },
    },
    required: ["title"],
  },
};

describe("tool schema round trip", () => {
  for (const tool of [emptyTool, nestedTool]) {
    const canonical = canonicalToolSchema(tool);

    it(`round-trips ${tool.name} through the chat-completions shape`, () => {
      const wire = toOpenAiChatTools([tool])![0]!;
      expect(toolSchemaFromOpenAiChat(wire)).toEqual(canonical);
    });

    it(`round-trips ${tool.name} through the responses shape`, () => {
      const wire = toOpenAiResponsesTools([tool])![0]!;
      expect(toolSchemaFromOpenAiResponses(wire)).toEqual(canonical);
    });

    it(`round-trips ${tool.name} through the Anthropic shape`, () => {
      const wire = toAnthropicTools([tool])![0]!;
      expect(toolSchemaFromAnthropic(wire)).toEqual(canonical);
    });
  }

  it("gives an empty-parameter tool a valid object schema everywhere", () => {
    expect(canonicalToolSchema(emptyTool).parameters).toEqual({ type: "object", properties: {} });
    expect(toOpenAiChatTools([emptyTool])![0]!.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(toOpenAiResponsesTools([emptyTool])![0]!.parameters).toEqual({ type: "object", properties: {} });
    expect(toAnthropicTools([emptyTool])![0]!.input_schema).toEqual({ type: "object", properties: {} });
  });

  it("keeps nested object schemas intact", () => {
    const wire = toAnthropicTools([nestedTool])![0]!;
    expect(wire.input_schema).toEqual(nestedTool.parameters);
  });
});

describe("tool call payloads", () => {
  it("reads arguments back from each wire shape", () => {
    expect(
      toolCallFromOpenAiChat({ id: "call_1", function: { name: "run_shell", arguments: '{"cmd":"ls"}' } }),
    ).toEqual({ id: "call_1", name: "run_shell", arguments: '{"cmd":"ls"}' });

    expect(
      toolCallFromOpenAiResponses({ call_id: "call_2", name: "read_file", arguments: '{"path":"a"}' }),
    ).toEqual({ id: "call_2", name: "read_file", arguments: '{"path":"a"}' });

    expect(toolCallFromAnthropic({ id: "toolu_3", name: "read_file", input: { path: "a" } })).toEqual({
      id: "toolu_3",
      name: "read_file",
      arguments: '{"path":"a"}',
    });
  });

  it("treats empty arguments as no arguments, not a parse failure", () => {
    expect(parseToolArguments("")).toEqual({ ok: true, value: {} });
    expect(parseToolArguments("   ")).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('{"cmd":"ls"}')).toEqual({ ok: true, value: { cmd: "ls" } });
    expect(parseToolArguments("[1,2]")).toMatchObject({ ok: false });
    expect(parseToolArguments("{oops")).toMatchObject({ ok: false });
  });
});
