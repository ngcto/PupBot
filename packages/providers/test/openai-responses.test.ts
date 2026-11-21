import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildResponsesRequest,
  openaiResponsesAdapter,
  wireResponsesInput,
} from "../src/adapters/openai-responses.ts";
import { collect, fixture, jsonResponse, sseResponse } from "./helpers.ts";
import type { ChatMessage } from "../src/types.ts";

const endpoint = { kind: "openai-responses" as const, baseUrl: "http://example.test/v1", model: "fixture-model" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai-responses adapter", () => {
  it("normalizes output text, reasoning summaries, function calls and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(fixture("openai-responses.sse"))));

    const events = await collect(
      openaiResponsesAdapter({
        endpoint: { ...endpoint, apiKey: "sk-fixture" },
        messages: [{ role: "user", content: "read notes" }],
      }),
    );

    expect(events).toEqual([
      { type: "reasoning_delta", text: "planning the read" },
      { type: "text_delta", text: "Woof" },
      { type: "tool_call_start", id: "call_fixture_2", name: "read_file" },
      { type: "tool_call_delta", id: "call_fixture_2", argumentsDelta: '{"path":' },
      { type: "tool_call_delta", id: "call_fixture_2", argumentsDelta: '"notes.txt"}' },
      { type: "tool_call_end", id: "call_fixture_2", arguments: '{"path":"notes.txt"}' },
      { type: "usage", inputTokens: 16, outputTokens: 9, cacheReadTokens: 8 },
    ]);
  });

  it("builds input items, instructions and function tools in the wire shape", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "read notes" },
      {
        role: "assistant",
        content: "Reading.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
      { role: "tool", toolCallId: "call_1", content: "hello" },
    ];

    expect(wireResponsesInput(messages)).toEqual({
      instructions: "be brief",
      input: [
        { role: "user", content: [{ type: "input_text", text: "read notes" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
        { type: "function_call_output", call_id: "call_1", output: "hello" },
      ],
    });

    const body = buildResponsesRequest({
      endpoint,
      messages,
      maxTokens: 256,
      tools: [{ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    });
    expect(body).toMatchObject({ model: "fixture-model", stream: true, store: false, max_output_tokens: 256 });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("reports a failed response as an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"backend exploded"}}}\n\n',
        ),
      ),
    );

    const events = await collect(openaiResponsesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events).toEqual([
      { type: "error", code: "server_error", retryable: true, message: "backend exploded" },
    ]);
  });

  it("maps an HTTP 401 to auth and an overloaded 529 to a retryable error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "no" } }, 401)));
    expect(
      (await collect(openaiResponsesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] })))[0],
    ).toMatchObject({ code: "auth", retryable: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 529 })));
    expect(
      (await collect(openaiResponsesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] })))[0],
    ).toMatchObject({ code: "overloaded", retryable: true, status: 529 });
  });

  it("stops producing events when aborted mid-stream", async () => {
    let cancelled = false;
    let sentSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentSignal = init.signal ?? undefined;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n',
                ),
              );
              await new Promise((resolve) => setTimeout(resolve, 40));
              try {
                controller.enqueue(
                  encoder.encode(
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"second"}\n\n',
                  ),
                );
                controller.close();
              } catch {
                // cancelled by the adapter
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const controller = new AbortController();
    const iterator = openaiResponsesAdapter({
      endpoint,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "first" });
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(sentSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
});
