export type EndpointKind = "openai-chat" | "openai-responses" | "anthropic-messages";

export const ENDPOINT_KINDS: readonly EndpointKind[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
];

export const DEFAULT_BASE_URLS: Record<EndpointKind, string> = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
};

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelEndpointConfig {
  kind: EndpointKind;
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  /** Sent to endpoints that accept a reasoning effort. */
  reasoningEffort?: ReasoningEffort;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Role `tool`: which call this is the result for. */
  toolCallId?: string;
  /** Role `tool`: function name (OpenAI chat accepts it, others ignore it). */
  name?: string;
  /** Role `assistant`: calls the previous turn made, replayed for tool results. */
  toolCalls?: ToolCall[];
}

export interface ToolSchema {
  name: string;
  description?: string;
  /** A JSON Schema object. Normalized by `canonicalToolSchema`. */
  parameters: Record<string, unknown>;
}

/** Normalized stream events every adapter translates into. */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string; arguments: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      /** Prompt tokens served from the provider's prompt cache (priced separately). */
      cacheReadTokens?: number;
      /** Prompt tokens written to the provider's prompt cache. */
      cacheWriteTokens?: number;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
    };

export interface StreamRequest {
  endpoint: ModelEndpointConfig;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Aborting must cancel the HTTP request and stop producing events. */
  signal?: AbortSignal;
  /**
   * Outbound HTTP, for callers that must police where the request may land
   * (`publicOnlyFetch` in the web app). Defaults to the global fetch.
   */
  fetch?: typeof globalThis.fetch;
}

export type StreamAdapter = (request: StreamRequest) => AsyncIterable<ModelEvent>;
