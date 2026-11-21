import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * A dev-only OpenAI-compatible endpoint. It exists so the entire chat path —
 * gateway adapter, SSE, run events, markdown — works with no API key at all.
 * Mounted only when STUB_PROVIDER is on and NODE_ENV is not production.
 */

const FIRST_TOKEN_DELAY_MS = 700;
const TOKEN_DELAY_MS = 28;

interface StubMessage {
  role?: string;
  content?: string;
}

function replyFor(messages: StubMessage[], model: string): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const quoted = lastUser.trim().slice(0, 120) || "(nothing)";
  return [
    `**Woof.** This came from the local stub endpoint, not a real model — \`${model}\` streamed it token by token so the whole path is exercised with no API key set.`,
    "",
    `You said: "${quoted}"`,
    "",
    "What is actually running here:",
    "",
    "- the API wrote your message and enqueued a run",
    "- the worker streamed it through the model gateway",
    "- every delta landed in `run_event`, so a reconnect replays it",
    "",
    "| piece | state |",
    "| --- | --- |",
    "| gateway | openai-chat |",
    "| transport | server-sent events |",
    "| tools | not in this phase |",
    "",
    "Send another message while I am still writing and I will stop mid-sentence, keep what I said, and answer the new one.",
  ].join("\n");
}

function chunkText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export const devStubRoutes = new Hono()
  .get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: [{ id: "tera-stub", object: "model", owned_by: "terabot" }],
    }),
  )
  .post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string;
      messages?: StubMessage[];
      stream?: boolean;
    };

    const model = body.model ?? "tera-stub";
    const text = replyFor(body.messages ?? [], model);
    const id = `chatcmpl-stub-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    return streamSSE(c, async (stream) => {
      const send = (payload: unknown) =>
        stream.writeSSE({ event: "message", data: JSON.stringify(payload) });

      await stream.sleep(FIRST_TOKEN_DELAY_MS);

      for (const chunk of chunkText(text)) {
        if (stream.aborted) return;
        await send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
        await stream.sleep(TOKEN_DELAY_MS);
      }

      await send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      await send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: { prompt_tokens: 64, completion_tokens: chunkText(text).length },
      });
      await stream.writeSSE({ event: "message", data: "[DONE]" });
    });
  });
