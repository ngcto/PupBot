import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiChatAdapter } from "../src/adapters/openai-chat.ts";
import type { ModelEvent } from "../src/types.ts";

function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai-chat adapter", () => {
  it("normalizes text, reasoning and usage into one event shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "Woof" } }] }),
          JSON.stringify({ choices: [{ delta: { content: " there" } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
          "[DONE]",
        ]),
      ),
    );

    const events = await collect(
      openaiChatAdapter({
        endpoint: { kind: "openai-chat", baseUrl: "http://example.test/v1", model: "test", apiKey: "sk-test" },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events).toEqual([
      { type: "reasoning_delta", text: "thinking" },
      { type: "text_delta", text: "Woof" },
      { type: "text_delta", text: " there" },
      { type: "usage", inputTokens: 12, outputTokens: 3 },
    ]);
  });

  it("assembles streamed tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: '{"cmd":' } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
          }),
          "[DONE]",
        ]),
      ),
    );

    const events = await collect(
      openaiChatAdapter({
        endpoint: { kind: "openai-chat", baseUrl: "http://example.test/v1", model: "test" },
        messages: [{ role: "user", content: "list files" }],
      }),
    );

    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", id: "call_1", argumentsDelta: '{"cmd":' },
      { type: "tool_call_delta", id: "call_1", argumentsDelta: '"ls"}' },
      { type: "tool_call_end", id: "call_1", arguments: '{"cmd":"ls"}' },
    ]);
  });

  it("reports an auth failure as an error event rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const events = await collect(
      openaiChatAdapter({
        endpoint: { kind: "openai-chat", baseUrl: "http://example.test/v1", model: "test" },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "auth", status: 401, retryable: false });
  });

  it("marks an unreachable endpoint as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const events = await collect(
      openaiChatAdapter({
        endpoint: { kind: "openai-chat", baseUrl: "http://example.test/v1", model: "test" },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events[0]).toMatchObject({ type: "error", code: "network_error", retryable: true });
  });
});
