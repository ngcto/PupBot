import { anthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import { openaiChatAdapter } from "./adapters/openai-chat.ts";
import { openaiResponsesAdapter } from "./adapters/openai-responses.ts";
import { UnsupportedEndpointError } from "./errors.ts";
import type { EndpointKind, ModelEvent, StreamAdapter, StreamRequest } from "./types.ts";

export interface ModelGateway {
  stream(request: StreamRequest): AsyncIterable<ModelEvent>;
}

export const defaultAdapters: Record<EndpointKind, StreamAdapter> = {
  "openai-chat": openaiChatAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
};

/**
 * One entry point for every wire format we support. Adapters own the
 * translation; callers only ever see `ModelEvent`.
 */
export class Gateway implements ModelGateway {
  readonly #adapters: Map<EndpointKind, StreamAdapter>;

  constructor(adapters: Partial<Record<EndpointKind, StreamAdapter>> = defaultAdapters) {
    this.#adapters = new Map(Object.entries(adapters) as Array<[EndpointKind, StreamAdapter]>);
  }

  register(kind: EndpointKind, adapter: StreamAdapter): this {
    this.#adapters.set(kind, adapter);
    return this;
  }

  async *stream(request: StreamRequest): AsyncIterable<ModelEvent> {
    const adapter = this.#adapters.get(request.endpoint.kind);
    if (!adapter) {
      yield {
        type: "error",
        code: "unsupported_endpoint",
        message: new UnsupportedEndpointError(request.endpoint.kind).message,
      };
      return;
    }
    yield* adapter(request);
  }
}

export const gateway = new Gateway();

export function createGateway(adapters?: Partial<Record<EndpointKind, StreamAdapter>>): Gateway {
  return new Gateway(adapters);
}
