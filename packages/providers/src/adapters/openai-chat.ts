import {
  errorEventFromHttp,
  finishReasonError,
  networkErrorEvent,
  streamErrorEvent,
} from "../errors.ts";
import { readSseData } from "../sse.ts";
import { toOpenAiChatTools } from "../tools.ts";
import type { ChatMessage, ModelEvent, StreamAdapter, StreamRequest, ToolCall } from "../types.ts";

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
      }
    | null;
  error?: { message?: string; type?: string; code?: string };
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function wireToolCalls(calls: ToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments || "{}" },
  }));
}

export function wireOpenAiChatMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: wireToolCalls(message.toolCalls),
      };
    }
    if (message.role === "assistant") {
      return { role: "assistant", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

export function buildOpenAiChatRequest(request: StreamRequest): Record<string, unknown> {
  const tools = toOpenAiChatTools(request.tools);
  return {
    model: request.endpoint.model,
    messages: wireOpenAiChatMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  };
}

interface OpenCall {
  id: string;
  name: string;
  args: string;
  pending: string;
  started: boolean;
}

function usageFrom(chunk: OpenAiChunk): ModelEvent | null {
  const usage = chunk.usage;
  if (!usage) return null;
  const totalInput = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  if (totalInput === undefined && outputTokens === undefined) return null;
  return {
    type: "usage",
    ...(totalInput !== undefined ? { inputTokens: Math.max(0, totalInput - cached) } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

/**
 * OpenAI chat-completions wire format. This is the adapter every BYO endpoint
 * (OpenAI, OpenRouter, Groq, a local llama.cpp, our dev stub) speaks.
 */
export const openaiChatAdapter: StreamAdapter = async function* (request) {
  const { endpoint, signal } = request;
  if (signal?.aborted) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...endpoint.headers,
  };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  let response: Response;
  try {
    const call = request.fetch ?? fetch;
    response = await call(joinUrl(endpoint.baseUrl, "chat/completions"), {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(buildOpenAiChatRequest(request)),
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

  const openCalls = new Map<string, OpenCall>();
  let lastKey: string | null = null;
  let finished = false;

  const closeAll = function* (): Generator<ModelEvent> {
    for (const call of openCalls.values()) {
      if (!call.started) continue;
      yield { type: "tool_call_end", id: call.id, arguments: call.args || "{}" };
    }
    openCalls.clear();
  };

  try {
    for await (const data of readSseData(response.body, signal)) {
      if (signal?.aborted) return;
      if (data === "[DONE]") break;

      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(data) as OpenAiChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        yield {
          type: "error",
          code: chunk.error.code ?? chunk.error.type ?? "stream_error",
          message: chunk.error.message ?? "the endpoint reported an error",
        };
        return;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { type: "reasoning_delta", text: reasoning };
      if (delta?.content) yield { type: "text_delta", text: delta.content };
      if (delta?.refusal) yield { type: "text_delta", text: delta.refusal };

      for (const call of delta?.tool_calls ?? []) {
        // `index` groups fragments of one call. Endpoints that omit it still
        // send a fresh `id` per call, so fall back to the id (and then to the
        // still-open call) instead of collapsing every call into index 0.
        const key: string =
          call.index !== undefined
            ? `index:${call.index}`
            : call.id
              ? `id:${call.id}`
              : (lastKey ?? `anon:${openCalls.size}`);
        let entry = openCalls.get(key);
        if (!entry) {
          entry = {
            id: call.id ?? `call_${openCalls.size}`,
            name: "",
            args: "",
            pending: "",
            started: false,
          };
          openCalls.set(key, entry);
        }
        lastKey = key;
        if (call.id) entry.id = call.id;
        if (call.function?.name && !entry.name.endsWith(call.function.name)) {
          entry.name += call.function.name;
        }

        if (!entry.started && entry.name) {
          entry.started = true;
          yield { type: "tool_call_start", id: entry.id, name: entry.name };
          if (entry.pending) {
            yield { type: "tool_call_delta", id: entry.id, argumentsDelta: entry.pending };
            entry.pending = "";
          }
        }

        const argumentsDelta = call.function?.arguments;
        if (argumentsDelta) {
          entry.args += argumentsDelta;
          if (entry.started) yield { type: "tool_call_delta", id: entry.id, argumentsDelta };
          else entry.pending += argumentsDelta;
        }
      }

      const usage = usageFrom(chunk);
      if (usage) yield usage;

      if (choice?.finish_reason) {
        finished = true;
        const failure = finishReasonError(choice.finish_reason);
        if (failure) {
          openCalls.clear();
          yield failure;
        } else {
          yield* closeAll();
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield streamErrorEvent(error);
    return;
  }

  if (signal?.aborted) return;
  if (!finished) {
    yield* closeAll();
  }
};
