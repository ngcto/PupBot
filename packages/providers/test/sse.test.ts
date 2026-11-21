import { describe, expect, it } from "vitest";
import { readSseEvents } from "../src/sse.ts";

function body(raw: string, chunkSize = raw.length): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
  return stream;
}

async function collect(raw: string, chunkSize?: number) {
  const events = [];
  for await (const event of readSseEvents(body(raw, chunkSize))) events.push(event);
  return events;
}

describe("SSE parser", () => {
  it("dispatches one event per blank line, keeping the event name", async () => {
    const events = await collect(
      'event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: {"b":2}\n\n',
    );
    expect(events).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "ping", data: '{"b":2}' },
    ]);
  });

  it("joins multi-line data and ignores comments and CRLF line endings", async () => {
    const events = await collect(': keepalive\r\ndata: line one\r\ndata: line two\r\n\r\n');
    expect(events).toEqual([{ data: "line one\nline two" }]);
  });

  it("survives arbitrary byte splits without duplicating or losing an event", async () => {
    const raw = "data: {\"text\":\"héllo wörld\"}\n\ndata: [DONE]\n\n";
    const whole = await collect(raw);
    const split = await collect(raw, 3);
    expect(split).toEqual(whole);
    expect(whole).toEqual([{ data: '{"text":"héllo wörld"}' }, { data: "[DONE]" }]);
  });

  it("flushes a final event that has no trailing blank line", async () => {
    expect(await collect("data: last")).toEqual([{ data: "last" }]);
  });
});
