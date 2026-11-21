import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelEvent } from "../src/types.ts";

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

/** A complete SSE body, optionally split into byte-sized pieces. */
export function sseResponse(raw: string, chunkSize = raw.length): Response {
  if (raw.length > 0 && (!Number.isInteger(chunkSize) || chunkSize <= 0)) {
    throw new TypeError("chunkSize must be a positive integer");
  }
  const bytes = new TextEncoder().encode(raw);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(bytes.slice(index, index + chunkSize));
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

