import { openaiChatAdapter } from "./adapters/openai-chat.ts";
import { UnsupportedEndpointError } from "./errors.ts";
import type { EndpointKind, ModelEvent, StreamAdapter, StreamRequest } from "./types.ts";

export interface ModelGateway {
  stream(request: StreamRequest): AsyncIterable<ModelEvent>;
}

/**
 * One entry point for every wire format we support. Adapters own the
 * translation; callers only ever see `ModelEvent`.
 */
export class Gateway implements ModelGateway {
  readonly #adapters: Map<EndpointKind, StreamAdapter>;

  constructor(adapters: Partial<Record<EndpointKind, StreamAdapter>> = { "openai-chat": openaiChatAdapter }) {
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
