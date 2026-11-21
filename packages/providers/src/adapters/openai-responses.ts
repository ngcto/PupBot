import { errorEventFromHttp, networkErrorEvent, streamErrorEvent } from "../errors.ts";
import { readSseEvents } from "../sse.ts";
import { toOpenAiResponsesTools } from "../tools.ts";
import type { ChatMessage, ModelEvent, StreamAdapter, StreamRequest } from "../types.ts";
import { joinUrl } from "./openai-chat.ts";

/**
 * OpenAI Responses wire format. Shapes here follow the Responses streaming
 * reference (platform.openai.com/docs/api-reference/responses-streaming) and
 * the Responses contract; see test/fixtures/README.md for what is recorded
 * vs docs-derived.
 */

export interface ResponsesInput {
  instructions?: string;
  input: Record<string, unknown>[];
}

export function wireResponsesInput(messages: ChatMessage[]): ResponsesInput {
  const systemParts: string[] = [];
  const input: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "call_0",
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments || "{}",
        });
      }
      continue;
    }
    input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
  }

  return {
    ...(systemParts.length > 0 ? { instructions: systemParts.join("\n\n") } : {}),
    input,
  };
}

export interface ResponsesRequestOptions {
  reasoningEffort?: StreamRequest["endpoint"]["reasoningEffort"];
}

export function buildResponsesRequest(
  request: StreamRequest,
  options: ResponsesRequestOptions = {},
): Record<string, unknown> {
  const { instructions, input } = wireResponsesInput(request.messages);
  const tools = toOpenAiResponsesTools(request.tools);
  const reasoningEffort = options.reasoningEffort ?? request.endpoint.reasoningEffort;

  return {
    model: request.endpoint.model,
    input,
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
  };
}

interface ResponseStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  code?: string;
  message?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    } | null;
  };
}

interface OpenCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
}

function mapEventCode(code: string | undefined): string {
  switch (code) {
    case "context_length_exceeded":
      return "context_overflow";
    case "rate_limit_exceeded":
    case "rate_limit_error":
      return "rate_limit";
    case "invalid_prompt":
    case "invalid_request_error":
      return "invalid_request";
    default:
      return code ?? "stream_error";
  }
}

/**
 * One SSE loop for the Responses API; the
 * only difference is the URL, headers and body the caller supplies.
 */
export async function* streamResponsesRequest(input: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): AsyncGenerator<ModelEvent> {
  const { signal } = input;
  if (signal?.aborted) return;

  let response: Response;
  try {
    const call = input.fetch ?? fetch;
    response = await call(input.url, {
      method: "POST",
      headers: input.headers,
      signal,
      body: JSON.stringify(input.body),
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

  const calls = new Map<string, OpenCall>();

  const close = function* (call: OpenCall): Generator<ModelEvent> {
    if (call.ended) return;
    call.ended = true;
    if (!call.started) {
      if (!call.name) return;
      call.started = true;
      yield { type: "tool_call_start", id: call.id, name: call.name };
    }
    yield { type: "tool_call_end", id: call.id, arguments: call.args || "{}" };
  };

  const closeAll = function* (): Generator<ModelEvent> {
    for (const call of calls.values()) yield* close(call);
    calls.clear();
  };

  let terminal = false;
  try {
    for await (const event of readSseEvents(response.body, signal)) {
      if (signal?.aborted) return;
      if (event.data === "[DONE]") {
        terminal = true;
        break;
      }

      let payload: ResponseStreamEvent;
      try {
        payload = JSON.parse(event.data) as ResponseStreamEvent;
      } catch {
        continue;
      }

      const type = payload.type ?? event.event;

      switch (type) {
        case "response.output_item.added": {
          const item = payload.item;
          if (item?.type !== "function_call") break;
          const id = item.call_id ?? item.id ?? "call_0";
          calls.set(item.id ?? id, {
            id,
            name: item.name ?? "",
            args: item.arguments ?? "",
            started: false,
            ended: false,
          });
          const call = calls.get(item.id ?? id)!;
          if (call.name) {
            call.started = true;
            yield { type: "tool_call_start", id: call.id, name: call.name };
            if (call.args) yield { type: "tool_call_delta", id: call.id, argumentsDelta: call.args };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const key = payload.item_id ?? "";
          let call = calls.get(key);
          if (!call) {
            call = { id: key || "call_0", name: "", args: "", started: true, ended: false };
            calls.set(key, call);
            yield { type: "tool_call_start", id: call.id, name: call.name };
          }
          call.args += payload.delta ?? "";
          if (payload.delta) yield { type: "tool_call_delta", id: call.id, argumentsDelta: payload.delta };
          break;
        }
        case "response.function_call_arguments.done": {
          const key = payload.item_id ?? "";
          const call = calls.get(key);
          if (!call) break;
          if (payload.arguments !== undefined) call.args = payload.arguments;
          yield* close(call);
          break;
        }
        case "response.output_item.done": {
          const item = payload.item;
          if (item?.type !== "function_call") break;
          const key = item.id ?? item.call_id ?? "";
          const call = calls.get(key);
          if (!call) break;
          if (item.arguments !== undefined) call.args = item.arguments;
          yield* close(call);
          break;
        }
        case "response.output_text.delta":
        case "response.refusal.delta":
          if (payload.delta) yield { type: "text_delta", text: payload.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (payload.delta) yield { type: "reasoning_delta", text: payload.delta };
          break;
        case "response.completed":
        case "response.incomplete": {
          terminal = true;
          yield* closeAll();
          const usage = payload.response?.usage;
          if (usage) {
            const cached = usage.input_tokens_details?.cached_tokens ?? 0;
            const totalInput = usage.input_tokens ?? 0;
            yield {
              type: "usage",
              inputTokens: Math.max(0, totalInput - cached),
              outputTokens: usage.output_tokens,
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
            };
          }
          if (type === "response.incomplete") {
            const reason = payload.response?.incomplete_details?.reason;
            if (reason === "max_output_tokens" || reason === "content_filter") {
              yield {
                type: "error",
                code: reason === "max_output_tokens" ? "max_tokens" : "content_filter",
                retryable: false,
                message:
                  reason === "max_output_tokens"
                    ? "the model hit its output limit; the answer is truncated"
                    : "the provider's content filter stopped the answer",
              };
            }
          }
          break;
        }
        case "response.failed": {
          terminal = true;
          const error = payload.response?.error;
          const code = mapEventCode(error?.code);
          yield {
            type: "error",
            code,
            retryable:
              code === "rate_limit" || code === "overloaded" || code === "server_error",
            message: error?.message ?? "the response failed",
          };
          return;
        }
        case "error": {
          terminal = true;
          const code = mapEventCode(payload.code);
          yield {
            type: "error",
            code,
            retryable:
              code === "rate_limit" || code === "overloaded" || code === "server_error",
            message: payload.message ?? "the endpoint reported an error",
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

  if (signal?.aborted) return;
  if (!terminal) {
    yield streamErrorEvent(new Error("the response stream ended before a terminal event"));
    return;
  }
  yield* closeAll();
}

export const openaiResponsesAdapter: StreamAdapter = async function* (request) {
  if (request.signal?.aborted) return;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...request.endpoint.headers,
  };
  if (request.endpoint.apiKey) headers.authorization = `Bearer ${request.endpoint.apiKey}`;

  yield* streamResponsesRequest({
    url: joinUrl(request.endpoint.baseUrl, "responses"),
    headers,
    body: buildResponsesRequest(request),
    signal: request.signal,
    ...(request.fetch ? { fetch: request.fetch } : {}),
  });
};
