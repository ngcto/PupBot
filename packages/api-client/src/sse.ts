/**
 * A Server-Sent Events reader that works on any runtime with a byte stream:
 * Node, Hermes through `expo/fetch`, or a test that feeds plain strings.
 *
 * React Native has no `EventSource`, so the client parses the API's `text/event-stream`
 * body itself. Everything here is incremental: a frame split across two reads, two
 * frames in one read, and CRLF line endings all resolve the same way.
 */

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
  cancel?(): Promise<void> | void;
  releaseLock?(): void;
}

export interface ByteStream {
  getReader(): ByteReader;
}

/**
 * One decoder per frame reader. A `TextDecoder` in streaming mode holds the
 * partial bytes of a multi-byte character between calls, so a module-wide one
 * would let two interleaved replies consume each other's state.
 */
function toText(
  value: Uint8Array | string | undefined,
  decoder: TextDecoder,
): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return decoder.decode(value, { stream: true });
}

/**
 * Pushes text in, yields whole frames out. A frame is only emitted on a blank
 * line, so an event whose `data:` line arrives in pieces is never dispatched twice.
 */
export class SseDecoder {
  private buffer = "";
  private decoder = new TextDecoder();

  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += toText(chunk, this.decoder);
    const events: SseEvent[] = [];

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

      if (line === "") {
        const event = this.dispatch();
        if (event) events.push(event);
        continue;
      }

      this.consumeLine(line);
    }

    return events;
  }

  flush(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = "";
    if (rest !== "") {
      for (const line of rest.split("\n")) this.consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    const event = this.dispatch();
    return event ? [event] : [];
  }

  private fields: { event: string; data: string[]; id: string | null } = {
    event: "",
    data: [],
    id: null,
  };

  private consumeLine(line: string) {
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? "" : line.slice(colon + 1);
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;

    if (field === "event") this.fields.event = value;
    else if (field === "data") this.fields.data.push(value);
    else if (field === "id") this.fields.id = value;
  }

  private dispatch(): SseEvent | null {
    const { event, data, id } = this.fields;
    this.fields = { event: "", data: [], id: null };
    if (!event && data.length === 0) return null;
    return { event: event || "message", data: data.join("\n"), id };
  }
}

/**
 * Reads frames until the stream ends. A `done` frame ends the loop, because the
 * API's replay log is finished at that point even if the socket lingers.
 */
export async function* readSseEvents(stream: ByteStream): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const sse = new SseDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of sse.push(value ?? "")) {
        yield event;
        if (event.event === "done") return;
      }
    }
    for (const event of sse.flush()) yield event;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // A cancelled reader throws when its lock is released; nothing to clean up.
    }
  }
}
