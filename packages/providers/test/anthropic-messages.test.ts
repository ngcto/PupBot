import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicMessagesAdapter,
  buildAnthropicRequest,
  wireAnthropicMessages,
} from "../src/adapters/anthropic-messages.ts";
import { collect, fixture, sseResponse } from "./helpers.ts";
import type { ChatMessage } from "../src/types.ts";

const endpoint = { kind: "anthropic-messages" as const, baseUrl: "http://example.test/v1", model: "claude-fixture" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic-messages adapter", () => {
  it("normalizes text, thinking, tool_use blocks and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(fixture("anthropic.sse"))));

    const events = await collect(
      anthropicMessagesAdapter({
        endpoint: { ...endpoint, apiKey: "sk-ant-fixture" },
        messages: [{ role: "user", content: "list files" }],
      }),
    );

    expect(events).toEqual([
      { type: "usage", inputTokens: 18, outputTokens: 1, cacheReadTokens: 6 },
      { type: "reasoning_delta", text: "checking the directory" },
      { type: "text_delta", text: "Woof" },
      { type: "tool_call_start", id: "toolu_fixture", name: "run_shell" },
      { type: "tool_call_delta", id: "toolu_fixture", argumentsDelta: '{"cmd":' },
      { type: "tool_call_delta", id: "toolu_fixture", argumentsDelta: '"ls"}' },
      { type: "tool_call_end", id: "toolu_fixture", arguments: '{"cmd":"ls"}' },
      { type: "usage", outputTokens: 14 },
    ]);
  });

  it("sends system as its own field and tool blocks in the wire shape", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "read notes" },
      {
        role: "assistant",
        content: "Reading.",
        toolCalls: [
          { id: "toolu_1", name: "read_file", arguments: '{"path":"a.txt"}' },
          { id: "toolu_2", name: "read_file", arguments: '{"path":"b.txt"}' },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", content: "hello" },
      { role: "tool", toolCallId: "toolu_2", content: "world" },
    ];

    expect(wireAnthropicMessages(messages)).toEqual({
      system: "be brief",
      messages: [
        { role: "user", content: [{ type: "text", text: "read notes" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "hello" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "world" },
          ],
        },
      ],
    });

    const body = buildAnthropicRequest({
      endpoint,
      messages,
      tools: [{ name: "read_file", description: "read a file", parameters: { type: "object", properties: {} } }],
    });
    expect(body).toMatchObject({ model: "claude-fixture", max_tokens: 4096, stream: true, system: "be brief" });
    expect(body.tools).toEqual([
      { name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("maps an overloaded stream error to a retryable 529", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ),
      ),
    );

    const events = await collect(anthropicMessagesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events).toEqual([
      { type: "error", code: "overloaded", retryable: true, status: 529, message: "Overloaded" },
    ]);
  });

  it("maps an HTTP 529 with an empty body to overloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 529 })));
    const events = await collect(anthropicMessagesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events[0]).toMatchObject({ type: "error", code: "overloaded", retryable: true, status: 529 });
  });

  it("maps a max_tokens stop reason to the max_tokens error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}',
            'event: message_stop\ndata: {"type":"message_stop"}',
            "",
          ].join("\n\n"),
        ),
      ),
    );

    const events = await collect(anthropicMessagesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "max_tokens", retryable: false });
  });

  it("reports a stream that ends before message_stop instead of completing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_half","name":"run_shell"}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"cmd":}}',
            "",
          ].join("\n\n"),
        ),
      ),
    );

    const events = await collect(anthropicMessagesAdapter({ endpoint, messages: [{ role: "user", content: "list" }] }));

    expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("message_stop") });
  });

  it("maps a 429 and carries Retry-After through as retryAfterMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
      ),
    );
    const events = await collect(anthropicMessagesAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events[0]).toMatchObject({
      type: "error",
      code: "rate_limit",
      retryable: true,
      status: 429,
      retryAfterMs: 7000,
    });
  });

  it("stops producing events when aborted mid-stream", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n',
                ),
              );
              await new Promise((resolve) => setTimeout(resolve, 40));
              try {
                controller.enqueue(
                  encoder.encode(
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}\n\n',
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
    const iterator = anthropicMessagesAdapter({
      endpoint,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "first" });
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(cancelled).toBe(true);
  });
});
