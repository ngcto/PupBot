import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAiChatRequest,
  openaiChatAdapter,
  wireOpenAiChatMessages,
} from "../src/adapters/openai-chat.ts";
import { collect, fixture, jsonResponse, sseResponse } from "./helpers.ts";
import type { ChatMessage, ModelEvent } from "../src/types.ts";

const endpoint = { kind: "openai-chat" as const, baseUrl: "http://example.test/v1", model: "fixture-model" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai-chat adapter", () => {
  it("normalizes text, reasoning, tool calls and usage into one event shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(fixture("openai-chat.sse"))));

    const events = await collect(
      openaiChatAdapter({
        endpoint: { ...endpoint, apiKey: "sk-fixture" },
        messages: [{ role: "user", content: "list files" }],
      }),
    );

    expect(events).toEqual([
      { type: "reasoning_delta", text: "checking the directory" },
      { type: "text_delta", text: "Woof" },
      { type: "tool_call_start", id: "call_fixture_1", name: "run_shell" },
      { type: "tool_call_delta", id: "call_fixture_1", argumentsDelta: '{"cmd":' },
      { type: "tool_call_delta", id: "call_fixture_1", argumentsDelta: '"ls"}' },
      { type: "tool_call_end", id: "call_fixture_1", arguments: '{"cmd":"ls"}' },
      { type: "usage", inputTokens: 31, outputTokens: 12 },
    ]);
  });

  it("separates cached prompt tokens from the uncached input count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Woof"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":80}}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
      ),
    );

    const events = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));

    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 20, outputTokens: 7, cacheReadTokens: 80 });
  });

  it("emits each delta once when a payload is split across byte chunks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(fixture("openai-chat.sse"), 7)));
    const split = await collect(
      openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "list files" }] }),
    );

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(fixture("openai-chat.sse"))));
    const whole = await collect(
      openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "list files" }] }),
    );

    expect(split).toEqual(whole);
    const texts = split.filter((event) => event.type === "text_delta").map((event) => event.text);
    expect(texts).toEqual(["Woof"]);
  });

  it("sends tool results and prior assistant tool calls in the wire shape", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "run_shell", arguments: '{"cmd":"ls"}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "run_shell", content: "a.txt" },
    ];

    expect(wireOpenAiChatMessages(messages)).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "run_shell", arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt", name: "run_shell" },
    ]);

    const body = buildOpenAiChatRequest({
      endpoint,
      messages,
      tools: [{ name: "run_shell", description: "run a command", parameters: { type: "object", properties: {} } }],
      maxTokens: 128,
    });
    expect(body).toMatchObject({
      model: "fixture-model",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128,
      tools: [
        {
          type: "function",
          function: {
            name: "run_shell",
            description: "run a command",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
  });

  it("maps a truncated answer to the max_tokens error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"half"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
      ),
    );

    const events = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events).toEqual([
      { type: "text_delta", text: "half" },
      { type: "usage", inputTokens: 5, outputTokens: 9 },
      { type: "error", code: "max_tokens", retryable: false, message: expect.stringContaining("truncated") },
    ]);
  });

  it("maps a rate limit response, including Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "retry-after": "3", "content-type": "application/json" },
        }),
      ),
    );

    const events = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events[0]).toMatchObject({
      type: "error",
      code: "rate_limit",
      status: 429,
      retryable: true,
      retryAfterMs: 3000,
    });
  });

  it("maps a context overflow 400 to context_overflow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "This model's maximum context length is 8192 tokens", code: "context_length_exceeded" } },
          400,
        ),
      ),
    );

    const events = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(events[0]).toMatchObject({ type: "error", code: "context_overflow", status: 400, retryable: false });
    expect(events[0]).toMatchObject({ message: expect.stringContaining("maximum context length") });
  });

  it("reports an auth failure and an unreachable endpoint without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const auth = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ type: "error", code: "auth", status: 401, retryable: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const network = await collect(openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }] }));
    expect(network[0]).toMatchObject({ type: "error", code: "network_error", retryable: true });
  });

  it("aborts the HTTP request, stops producing events, and never repeats a delta", async () => {
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
                encoder.encode('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n'),
              );
              await new Promise((resolve) => setTimeout(resolve, 40));
              try {
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"second"},"finish_reason":null}]}\n\n'),
                );
                controller.close();
              } catch {
                // the adapter cancelled the body on abort
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
    const iterator = openaiChatAdapter({
      endpoint,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text_delta", text: "first" });

    controller.abort();
    const rest: ModelEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    expect(sentSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(rest).toEqual([]);
  });

  it("does not start a request when the signal is already aborted", async () => {
    const fetchMock = vi.fn(async () => sseResponse(fixture("openai-chat.sse")));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      openaiChatAdapter({ endpoint, messages: [{ role: "user", content: "hi" }], signal: controller.signal }),
    );
    expect(events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
