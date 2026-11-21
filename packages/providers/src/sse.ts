export interface SseEvent {
  /** The `event:` field when the wire format sends one (Anthropic does). */
  event?: string;
  /** The `data:` payload, with multi-line data joined by newlines. */
  data: string;
  id?: string;
}

/**
 * Parses a `text/event-stream` body into dispatched SSE events.
 * Splits records on CRLF, LF, or CR blank-line boundaries, ignores comment
 * lines, and only dispatches records that contain a `data:` field.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  const dispatch = (raw: string): SseEvent | null => {
    let eventName: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];
    let sawData = false;
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "event":
          eventName = value;
          break;
        case "data":
          sawData = true;
          dataLines.push(value);
          break;
        case "id":
          // Per SSE, ids containing U+0000 NULL are ignored.
          if (!value.includes("\0")) id = value;
          break;
        default:
          break;
      }
    }
    if (!sawData) return null;
    return {
      data: dataLines.join("\n"),
      ...(eventName ? { event: eventName } : {}),
      ...(id ? { id } : {}),
    };
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/)) !== -1) {
        const sep = buffer.startsWith("\r\n\r\n", boundary) ? 4 : 2;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + sep);
        if (signal?.aborted) return;
        const event = dispatch(raw);
        if (event) yield event;
      }
    }
    if (signal?.aborted) return;
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = dispatch(buffer);
      if (!signal?.aborted && event) yield event;
    }
  } finally {
    // Cancelling releases the lock and aborts the underlying fetch; without it
    // an early consumer exit leaves the HTTP body open.
    try {
      await reader.cancel();
    } catch {
      // already closed or cancelled
    }
  }
}

/** Convenience: yields only the `data:` payloads. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for await (const event of readSseEvents(body, signal)) yield event.data;
}
