import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  StreamUnsupportedError,
  UnauthorizedError,
  createApiClient,
  createMemorySessionStore,
  serializeCookies,
} from "../src/client.ts";
import type { FetchLike, RequestInitLike, ResponseLike } from "../src/client.ts";
import type { ByteStream } from "../src/sse.ts";

interface Call {
  url: string;
  init: RequestInitLike | undefined;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    body: null,
  };
}

function streamResponse(chunks: string[]): ResponseLike {
  let index = 0;
  const body: ByteStream = {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    text: async () => "",
    body,
  };
}

function brokenStreamResponse(chunks: string[]): ResponseLike {
  let index = 0;
  const body: ByteStream = {
    getReader() {
      return {
        async read() {
          if (index < chunks.length) {
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          }
          throw new TypeError("network connection was lost");
        },
      };
    },
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    text: async () => "",
    body,
  };
}

function fakeFetch(responses: ResponseLike[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) throw new Error("no response queued");
    return response;
  };
  return { fetch, calls };
}

const user = { id: "u1", name: "Ng", email: "ng@example.com" };

function botJson(overrides: Record<string, unknown> = {}) {
  return {
    id: "bot-1",
    name: "Tera",
    avatar: { shape: "mug", color: "amber" },
    accentColor: "#f69412",
    unread: false,
    pinned: false,
    isPrimary: true,
    position: 0,
    conversationId: "conv-1",
    lastMessagePreview: "hello",
    lastMessageAt: "2026-11-21T10:00:00.000Z",
    computer: { id: "c1", provider: "instabox", status: "awake", lastUsedAt: null },
    model: {
      endpointId: "e1",
      endpointLabel: "OpenAI",
      kind: "openai-chat",
      modelId: "gpt-6-luna",
      contextWindow: 1050000,
      catalogMatch: "matched",
    },
    activeRun: false,
    instructions: "",
    createdAt: "2026-11-21T09:00:00.000Z",
    ...overrides,
  };
}

describe("session cookies", () => {
  it("joins the cookies the server issued into one header", () => {
    expect(
      serializeCookies([
        { name: "terabot.session_token", value: "abc.def" },
        { name: "terabot.session_data", value: "xyz" },
      ]),
    ).toBe("terabot.session_token=abc.def; terabot.session_data=xyz");
  });
});

describe("sign in", () => {
  it("stores the session cookie and returns the user", async () => {
    const store = createMemorySessionStore();
    const { fetch, calls } = fakeFetch([
      jsonResponse({ user, cookies: [{ name: "terabot.session_token", value: "abc.def" }] }),
    ]);
    const client = createApiClient({ baseUrl: "http://api.test/", session: store, fetch });

    const signedIn = await client.signIn({ email: "ng@example.com", password: "hunter2hunter2" });

    expect(signedIn.email).toBe("ng@example.com");
    expect(await store.read()).toBe("terabot.session_token=abc.def");
    expect(calls[0]?.url).toBe("http://api.test/m/auth/sign-in");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      email: "ng@example.com",
      password: "hunter2hunter2",
    });
  });

  it("refuses a sign-in without a session cookie", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore(),
      fetch: fakeFetch([jsonResponse({ user, cookies: [] })]).fetch,
    });

    await expect(client.signIn({ email: "a@b.c", password: "hunter2hunter2" })).rejects.toThrow(ApiError);
  });
});

describe("requests", () => {
  it("sends the stored cookie on every call", async () => {
    const { fetch, calls } = fakeFetch([jsonResponse({ bots: [botJson()] })]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("terabot.session_token=abc.def"),
      fetch,
    });

    const bots = await client.listBots();

    expect(bots).toHaveLength(1);
    expect(bots[0]?.avatar.shape).toBe("mug");
    expect(calls[0]?.init?.headers?.cookie).toBe("terabot.session_token=abc.def");
  });

  it("clears the session and reports unauthorized once the server says so", async () => {
    const store = createMemorySessionStore("terabot.session_token=stale");
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: store,
      fetch: fakeFetch([jsonResponse({ error: "unauthorized" }, 401)]).fetch,
      onUnauthorized,
    });

    await expect(client.listBots()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await store.read()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("passes the server's error detail through", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch: fakeFetch([jsonResponse({ error: "invalid_body", message: "a message needs text" }, 400)]).fetch,
    });

    await expect(client.sendMessage("conv-1", " ")).rejects.toMatchObject({
      status: 400,
      code: "invalid_body",
      message: "a message needs text",
    });
  });

  it("rejects a body the client cannot read rather than half-rendering it", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch: fakeFetch([jsonResponse({ bots: [{ id: "only-an-id" }] })]).fetch,
    });

    await expect(client.listBots()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("patches only the avatar it is given", async () => {
    const { fetch, calls } = fakeFetch([jsonResponse({ bot: botJson() })]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    const bot = await client.setAvatar("bot-1", { shape: "ghost", color: "violet" });

    expect(bot.id).toBe("bot-1");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ avatar: { shape: "ghost", color: "violet" } });
  });

  it("signs out even when the server call fails", async () => {
    const store = createMemorySessionStore("terabot.session_token=abc");
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: store,
      fetch: fakeFetch([jsonResponse({ error: "boom" }, 500)]).fetch,
    });

    await expect(client.signOut()).resolves.toBeUndefined();
    expect(await store.read()).toBeNull();
  });
});

describe("streaming a run", () => {
  const frame = (event: string, payload: unknown, seq = 1) =>
    `event: ${event}\ndata: ${JSON.stringify({ seq, type: event, payload })}\n\n`;

  it("delivers each frame as it arrives, in order", async () => {
    const chunks = [
      "event: open\ndata: {}\n\n",
      frame("run.started", { messageId: "m1" }),
      frame("text_delta", { text: "Hel" }),
      frame("text_delta", { text: "lo" }),
      frame("message.completed", { messageId: "m1", text: "Hello", status: "complete" }),
      frame("run.completed", { status: "done" }),
      'event: done\ndata: {"status":"done"}\n\n',
    ];
    const { fetch, calls } = fakeFetch([streamResponse(chunks)]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("terabot.session_token=abc"),
      fetch,
    });

    const seen: string[] = [];
    const text: string[] = [];
    const result = await client.streamRun("run-1", {
      after: 3,
      onEvent: (event) => {
        seen.push(event.type);
        if (event.type === "text_delta") text.push(String(event.payload.text));
      },
    });

    expect(result.status).toBe("done");
    expect(seen).toEqual(["run.started", "text_delta", "text_delta", "message.completed", "run.completed"]);
    expect(text.join("")).toBe("Hello");
    expect(calls[0]?.url).toBe("http://api.test/runs/run-1/events?after=3");
    expect(calls[0]?.init?.headers?.accept).toBe("text/event-stream");
    expect(calls[0]?.init?.headers?.cookie).toBe("terabot.session_token=abc");
  });

  it("tells the caller when the runtime has no readable body", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch: fakeFetch([jsonResponse({}, 200)]).fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).rejects.toBeInstanceOf(StreamUnsupportedError);
  });

  it("resumes from the last sequence when the socket closes early", async () => {
    const reopened = [
      "event: open\ndata: {}\n\n",
      frame("run.started", { messageId: "m1" }, 1),
      frame("text_delta", { text: "Hel" }, 2),
    ];
    const resumed = [frame("text_delta", { text: "lo" }, 3), frame("run.completed", { status: "done" }, 4)];

    const { fetch, calls } = fakeFetch([streamResponse(reopened), streamResponse(resumed)]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    const text: string[] = [];
    const result = await client.streamRun("run-1", {
      onEvent: (event) => {
        if (event.type === "text_delta") text.push(String(event.payload.text));
      },
    });

    expect(result.status).toBe("done");
    expect(text.join("")).toBe("Hello");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("http://api.test/runs/run-1/events?after=2");
  });

  it("resumes after the socket errors mid-reply", async () => {
    const dropped = ["event: open\ndata: {}\n\n", frame("text_delta", { text: "Hel" }, 1)];
    const resumed = [frame("text_delta", { text: "lo" }, 2), 'event: done\ndata: {"status":"done"}\n\n'];
    const { fetch, calls } = fakeFetch([brokenStreamResponse(dropped), streamResponse(resumed)]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    const text: string[] = [];
    const result = await client.streamRun("run-1", {
      onEvent: (event) => {
        if (event.type === "text_delta") text.push(String(event.payload.text));
      },
    });

    expect(result.status).toBe("done");
    expect(text.join("")).toBe("Hello");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("http://api.test/runs/run-1/events?after=1");
  });

  it("keeps resuming while each connection delivers new events", async () => {
    const first = [frame("text_delta", { text: "a" }, 1)];
    const second = [frame("text_delta", { text: "b" }, 2)];
    const third = [frame("text_delta", { text: "c" }, 3)];
    const fourth = [frame("run.completed", { status: "done" }, 4)];
    const { fetch, calls } = fakeFetch([
      streamResponse(first),
      streamResponse(second),
      streamResponse(third),
      streamResponse(fourth),
    ]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).resolves.toEqual({ status: "done" });
    expect(calls).toHaveLength(4);
    expect(calls[3]?.url).toBe("http://api.test/runs/run-1/events?after=3");
  });

  it("does not retry when the caller aborted", async () => {
    const controller = { aborted: true };
    const chunks = ["event: open\ndata: {}\n\n"];
    const { fetch, calls } = fakeFetch([brokenStreamResponse(chunks), streamResponse([])]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {}, signal: controller })).rejects.toThrow(
      "network connection was lost",
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a stream that never finishes instead of a truncated reply", async () => {
    const truncated = [frame("text_delta", { text: "half" })];
    const { fetch, calls } = fakeFetch([streamResponse(truncated)]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).rejects.toMatchObject({
      code: "stream_incomplete",
    });
    // One attempt made progress (seq 1), then three idle drops exhaust the budget.
    expect(calls).toHaveLength(4);
  });

  it("treats a terminal run event as the end even without a done frame", async () => {
    const { fetch, calls } = fakeFetch([
      streamResponse([frame("text_delta", { text: "ok" }), frame("run.completed", { status: "done" })]),
    ]);
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).resolves.toEqual({ status: "done" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces a run error frame", async () => {
    const chunks = ["event: error\ndata: {\"message\":\"gateway down\"}\n\n"];
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch: fakeFetch([streamResponse(chunks)]).fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).rejects.toMatchObject({
      message: "gateway down",
    });
  });
});
