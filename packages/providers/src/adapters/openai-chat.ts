import { readSseData } from "../sse.ts";
import type { ChatMessage, ModelEvent, StreamAdapter } from "../types.ts";

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string };
}

function wireMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    }
    return { role: message.role, content: message.content };
  });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

/**
 * OpenAI chat-completions wire format. This is the adapter every BYO endpoint
 * (OpenAI, OpenRouter, Groq, a local llama.cpp, our dev stub) speaks.
 */
export const openaiChatAdapter: StreamAdapter = async function* (request) {
  const { endpoint, signal } = request;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...endpoint.headers,
  };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  let response: Response;
  try {
    response = await fetch(joinUrl(endpoint.baseUrl, "chat/completions"), {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages: wireMessages(request.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
            }
          : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
    });
  } catch (error) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      code: "network_error",
      retryable: true,
      message: error instanceof Error ? error.message : "the endpoint could not be reached",
    };
    return;
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    yield {
      type: "error",
      code: response.status === 401 || response.status === 403 ? "auth" : "http_error",
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      message: `endpoint answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    };
    return;
  }

  const openCalls = new Map<number, { id: string; name: string; args: string }>();

  try {
    for await (const data of readSseData(response.body, signal)) {
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

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { type: "reasoning_delta", text: delta.reasoning_content };
      else if (delta?.reasoning) yield { type: "reasoning_delta", text: delta.reasoning };

      if (delta?.content) yield { type: "text_delta", text: delta.content };

      for (const call of delta?.tool_calls ?? []) {
        const existing = openCalls.get(call.index);
        if (call.id || !existing) {
          if (existing) {
            yield { type: "tool_call_end", id: existing.id, arguments: existing.args };
          }
          const created = { id: call.id ?? `call_${call.index}`, name: call.function?.name ?? "", args: "" };
          openCalls.set(call.index, created);
          yield { type: "tool_call_start", id: created.id, name: created.name };
        }
        const current = openCalls.get(call.index);
        const argumentsDelta = call.function?.arguments;
        if (current && argumentsDelta) {
          current.args += argumentsDelta;
          yield { type: "tool_call_delta", id: current.id, argumentsDelta };
        }
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      code: "stream_interrupted",
      retryable: true,
      message: error instanceof Error ? error.message : "the stream ended unexpectedly",
    };
    return;
  }

  for (const call of openCalls.values()) {
    yield { type: "tool_call_end", id: call.id, arguments: call.args };
  }
};
