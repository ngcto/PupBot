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
        { name: "pupbot.session_token", value: "abc.def" },
        { name: "pupbot.session_data", value: "xyz" },
      ]),
    ).toBe("pupbot.session_token=abc.def; pupbot.session_data=xyz");
  });
});

describe("sign in", () => {
  it("stores the session cookie and returns the user", async () => {
    const store = createMemorySessionStore();
    const { fetch, calls } = fakeFetch([
      jsonResponse({ user, cookies: [{ name: "pupbot.session_token", value: "abc.def" }] }),
    ]);
    const client = createApiClient({ baseUrl: "http://api.test/", session: store, fetch });

    const signedIn = await client.signIn({ email: "ng@example.com", password: "hunter2hunter2" });

    expect(signedIn.email).toBe("ng@example.com");
    expect(await store.read()).toBe("pupbot.session_token=abc.def");
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
      session: createMemorySessionStore("pupbot.session_token=abc.def"),
      fetch,
    });

    const bots = await client.listBots();

    expect(bots).toHaveLength(1);
    expect(bots[0]?.avatar.shape).toBe("mug");
    expect(calls[0]?.init?.headers?.cookie).toBe("pupbot.session_token=abc.def");
  });

  it("clears the session and reports unauthorized once the server says so", async () => {
    const store = createMemorySessionStore("pupbot.session_token=stale");
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
    const store = createMemorySessionStore("pupbot.session_token=abc");
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
  const frame = (event: string, payload: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify({ seq: 1, type: event, payload })}\n\n`;

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
      session: createMemorySessionStore("pupbot.session_token=abc"),
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
    expect(calls[0]?.init?.headers?.cookie).toBe("pupbot.session_token=abc");
  });

  it("tells the caller when the runtime has no readable body", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      session: createMemorySessionStore("c=1"),
      fetch: fakeFetch([jsonResponse({}, 200)]).fetch,
    });

    await expect(client.streamRun("run-1", { onEvent: () => {} })).rejects.toBeInstanceOf(StreamUnsupportedError);
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
