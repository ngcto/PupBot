import { errorEventFromHttp, finishReasonError, networkErrorEvent, streamErrorEvent } from "../errors.ts";
import { readSseEvents } from "../sse.ts";
import { parseToolArguments, toAnthropicTools } from "../tools.ts";
import type { ChatMessage, ModelEvent, StreamAdapter, StreamRequest } from "../types.ts";
import { joinUrl } from "./openai-chat.ts";

/**
 * Anthropic Messages wire format. Fixtures follow the Messages streaming docs
 * (docs.anthropic.com/en/api/messages-streaming); see test/fixtures/README.md.
 */

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface WireMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function pushBlocks(messages: WireMessage[], role: WireMessage["role"], blocks: AnthropicBlock[]): void {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

export function wireAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: WireMessage[];
} {
  const systemParts: string[] = [];
  const wire: WireMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      pushBlocks(wire, "user", [
        { type: "tool_result", tool_use_id: message.toolCallId ?? "call_0", content: message.content },
      ]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        const parsed = parseToolArguments(call.arguments);
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parsed.ok ? parsed.value : {},
        });
      }
      pushBlocks(wire, "assistant", blocks);
      continue;
    }
    pushBlocks(wire, "user", [{ type: "text", text: message.content }]);
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: wire,
  };
}

export function buildAnthropicRequest(request: StreamRequest): Record<string, unknown> {
  const { system, messages } = wireAnthropicMessages(request.messages);
  const tools = toAnthropicTools(request.tools);
  return {
    model: request.endpoint.model,
    max_tokens: request.maxTokens ?? 4096,
    messages,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

interface OpenBlock {
  index: number;
  id: string;
  name: string;
  args: string;
}

function mapAnthropicErrorType(type: string | undefined): { code: string; retryable: boolean } {
  switch (type) {
    case "overloaded_error":
      return { code: "overloaded", retryable: true };
    case "rate_limit_error":
      return { code: "rate_limit", retryable: true };
    case "authentication_error":
    case "permission_error":
      return { code: "auth", retryable: false };
    case "invalid_request_error":
      return { code: "invalid_request", retryable: false };
    case "api_error":
      return { code: "server_error", retryable: true };
    case "not_found_error":
      return { code: "model_not_found", retryable: false };
    default:
      return { code: type ?? "stream_error", retryable: false };
  }
}

export const anthropicMessagesAdapter: StreamAdapter = async function* (request) {
  const { endpoint, signal } = request;
  if (signal?.aborted) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    ...endpoint.headers,
  };
  if (endpoint.apiKey) headers["x-api-key"] = endpoint.apiKey;

  let response: Response;
  try {
    const call = request.fetch ?? fetch;
    response = await call(joinUrl(endpoint.baseUrl, "messages"), {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(buildAnthropicRequest(request)),
    });
  } catch (error) {
    if (signal?.aborted) return;
    yield networkErrorEvent(error);
    return;
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    yield errorEventFromHttp(response.status, detail, response.headers);
    return;
  }

  const blocks = new Map<number, OpenBlock>();
  let stopReason: string | null = null;
  let sawStop = false;

  const close = function* (block: OpenBlock): Generator<ModelEvent> {
    blocks.delete(block.index);
    yield { type: "tool_call_end", id: block.id, arguments: block.args || "{}" };
  };

  try {
    for await (const event of readSseEvents(response.body, signal)) {
      if (signal?.aborted) return;

      let payload: AnthropicStreamEvent;
      try {
        payload = JSON.parse(event.data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      const type = payload.type ?? event.event;

      switch (type) {
        case "message_start": {
          const usage = payload.message?.usage;
          if (usage) {
            yield {
              type: "usage",
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
              ...(usage.cache_creation_input_tokens
                ? { cacheWriteTokens: usage.cache_creation_input_tokens }
                : {}),
            };
          }
          break;
        }
        case "content_block_start": {
          const block = payload.content_block;
          if (block?.type === "tool_use") {
            const index = payload.index ?? 0;
            const call = { index, id: block.id ?? `call_${index}`, name: block.name ?? "", args: "" };
            blocks.set(index, call);
            yield { type: "tool_call_start", id: call.id, name: call.name };
          }
          break;
        }
        case "content_block_delta": {
          const delta = payload.delta;
          if (delta?.type === "text_delta" && delta.text) yield { type: "text_delta", text: delta.text };
          else if (delta?.type === "thinking_delta" && delta.thinking) {
            yield { type: "reasoning_delta", text: delta.thinking };
          } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
            const call = blocks.get(payload.index ?? 0);
            if (call) {
              call.args += delta.partial_json;
              yield { type: "tool_call_delta", id: call.id, argumentsDelta: delta.partial_json };
            }
          }
          break;
        }
        case "content_block_stop": {
          const call = blocks.get(payload.index ?? 0);
          if (call) yield* close(call);
          break;
        }
        case "message_delta": {
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
          const usage = payload.usage;
          if (usage) {
            // `input_tokens` is carried here as well as on `message_start`, and on some
            // endpoints it is *only* populated here — `message_start` reports zero and
            // the final count arrives on the delta. Dropping it made a caller that sums
            // usage events record zero prompt tokens for every turn.
            yield {
              type: "usage",
              outputTokens: usage.output_tokens,
              ...(usage.input_tokens ? { inputTokens: usage.input_tokens } : {}),
              ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
              ...(usage.cache_creation_input_tokens
                ? { cacheWriteTokens: usage.cache_creation_input_tokens }
                : {}),
            };
          }
          break;
        }
        case "message_stop": {
          sawStop = true;
          for (const block of [...blocks.values()]) yield* close(block);
          if (stopReason) {
            const failure = finishReasonError(stopReason);
            if (failure) yield failure;
          }
          break;
        }
        case "error": {
          const mapped = mapAnthropicErrorType(payload.error?.type);
          yield {
            type: "error",
            code: mapped.code,
            retryable: mapped.retryable,
            ...(mapped.code === "overloaded" ? { status: 529 } : {}),
            message: payload.error?.message ?? "the endpoint reported an error",
          };
          return;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield streamErrorEvent(error);
    return;
  }

  // A stream that ends without `message_stop` is a truncated answer, not a
  // finished one: say so rather than closing open tool calls as if complete.
  if (signal?.aborted) return;
  if (!sawStop) {
    yield streamErrorEvent(new Error("the message stream ended before message_stop"));
  }
};
