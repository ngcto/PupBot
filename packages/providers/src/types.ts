export type EndpointKind = "openai-chat" | "openai-responses" | "anthropic-messages" | "chatgpt-oauth";

export interface ModelEndpointConfig {
  kind: EndpointKind;
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Normalized stream events every adapter translates into. */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string; arguments: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string; code?: string; retryable?: boolean; status?: number };

export interface StreamRequest {
  endpoint: ModelEndpointConfig;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamAdapter = (request: StreamRequest) => AsyncIterable<ModelEvent>;
