import { describe, expect, it } from "vitest";
import { SseDecoder, readSseEvents } from "../src/sse.ts";
import type { ByteStream } from "../src/sse.ts";

function streamOf(chunks: string[]): ByteStream {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

describe("SseDecoder", () => {
  it("emits a frame only once its blank line arrives", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("event: text_delta\n")).toEqual([]);
    expect(decoder.push('data: {"a":1}')).toEqual([]);
    const events = decoder.push("\n\n");
    expect(events).toEqual([{ event: "text_delta", data: '{"a":1}', id: null }]);
  });

  it("splits two frames that arrive in one chunk", () => {
    const decoder = new SseDecoder();
    const events = decoder.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(events.map((event) => event.event)).toEqual(["a", "b"]);
    expect(events.map((event) => event.data)).toEqual(["1", "2"]);
  });

  it("strips CRLF line endings and keeps the id", () => {
    const decoder = new SseDecoder();
    const events = decoder.push("id: 7\r\nevent: step\r\ndata: {\"label\":\"Thinking\"}\r\n\r\n");
    expect(events).toEqual([{ event: "step", data: '{"label":"Thinking"}', id: "7" }]);
  });

  it("joins multi-line data and ignores comments and unknown fields", () => {
    const decoder = new SseDecoder();
    const events = decoder.push(": keep-alive\nretry: 500\nevent: x\ndata: one\ndata: two\n\n");
    expect(events).toEqual([{ event: "x", data: "one\ntwo", id: null }]);
  });

  it("falls back to the default event name", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: hello\n\n")).toEqual([{ event: "message", data: "hello", id: null }]);
  });

  it("does not emit a frame for a blank block", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("\n\n")).toEqual([]);
  });
});

describe("readSseEvents", () => {
  it("yields frames across chunk boundaries and stops at done", async () => {
    const stream = streamOf([
      "event: open\ndata: {}",
      "\n\nevent: text_delta\nda",
      'ta: {"seq":1}\n\nevent: done\ndata: {"status":"done"}\n\n',
      "event: text_delta\ndata: ignored\n\n",
    ]);

    const seen: string[] = [];
    for await (const frame of readSseEvents(stream)) seen.push(frame.event);

    expect(seen).toEqual(["open", "text_delta", "done"]);
  });

  it("flushes a trailing frame with no blank line", async () => {
    const stream = streamOf(["event: last\ndata: tail"]);
    const seen: string[] = [];
    for await (const frame of readSseEvents(stream)) seen.push(`${frame.event}:${frame.data}`);
    expect(seen).toEqual(["last:tail"]);
  });
});
