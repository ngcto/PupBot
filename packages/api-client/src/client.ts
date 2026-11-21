import { readSseEvents } from "./sse.ts";
import type { ByteStream } from "./sse.ts";
import {
  botResponseSchema,
  botsResponseSchema,
  conversationMessagesSchema,
  meResponseSchema,
  sendMessageResponseSchema,
  signInResponseSchema,
} from "./types.ts";
import type {
  Avatar,
  BotDetail,
  BotSummary,
  ConversationMessages,
  MeResponse,
  RunEvent,
  SendMessageResponse,
  SessionUser,
} from "./types.ts";
import type { z } from "zod";

/**
 * The HTTP client every surface shares. It holds no platform code: the caller
 * injects `fetch` (global, or `expo/fetch` on a phone) and a session store, which
 * keeps it runnable in unit tests and in Node against a live API.
 */

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ByteStream | null;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<ResponseLike>;

/** Where the cookie header from sign-in lives: `expo-secure-store` on a device. */
export interface SessionStore {
  read(): Promise<string | null>;
  write(cookie: string): Promise<void>;
  clear(): Promise<void>;
}

export function createMemorySessionStore(initial: string | null = null): SessionStore {
  let cookie = initial;
  return {
    async read() {
      return cookie;
    },
    async write(value) {
      cookie = value;
    },
    async clear() {
      cookie = null;
    },
  };
}

const STREAM_RECONNECTS = 2;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 401: the stored session is gone, so the caller sends the user back to sign-in. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, "unauthorized", "Your session expired. Sign in again.");
    this.name = "UnauthorizedError";
  }
}

/** The runtime gave us a response with no readable body, so nothing can stream. */
export class StreamUnsupportedError extends Error {
  constructor() {
    super("This device cannot stream replies. Update the app and try again.");
    this.name = "StreamUnsupportedError";
  }
}

export function serializeCookies(cookies: { name: string; value: string }[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export interface ApiClientOptions {
  baseUrl: string;
  session: SessionStore;
  fetch?: FetchLike;
  onUnauthorized?: () => void;
}

export interface StreamRunOptions {
  after?: number;
  signal?: unknown;
  onEvent: (event: RunEvent) => void;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  signIn(input: SignInInput): Promise<SessionUser>;
  signOut(): Promise<void>;
  hasSession(): Promise<boolean>;
  me(): Promise<MeResponse>;
  listBots(): Promise<BotSummary[]>;
  getBot(botId: string): Promise<BotDetail>;
  setAvatar(botId: string, avatar: Avatar): Promise<BotDetail>;
  messages(botId: string): Promise<ConversationMessages>;
  sendMessage(conversationId: string, text: string): Promise<SendMessageResponse>;
  streamRun(runId: string, options: StreamRunOptions): Promise<{ status: string }>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const session = options.session;

  const doFetch: FetchLike =
    options.fetch ??
    ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: unknown; cookie?: string | null } = {},
  ): Promise<T> {
    const cookie = init.cookie === undefined ? await session.read() : init.cookie;
    const response = await doFetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    const body: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      if (response.status === 401) {
        await session.clear();
        options.onUnauthorized?.();
        throw new UnauthorizedError();
      }
      const detail = body as { error?: string; message?: string } | null;
      throw new ApiError(
        response.status,
        detail?.error ?? "request_failed",
        detail?.message ?? detail?.error ?? `Request failed (${response.status}).`,
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(response.status, "invalid_response", "The server sent something the app cannot read.");
    }
    return parsed.data;
  }

  return {
    baseUrl,

    async signIn(input) {
      const result = await request("/m/auth/sign-in", signInResponseSchema, {
        method: "POST",
        body: input,
        cookie: null,
      });
      if (result.cookies.length === 0) {
        throw new ApiError(500, "no_session_cookie", "Sign-in succeeded but no session was issued.");
      }
      await session.write(serializeCookies(result.cookies));
      return result.user;
    },

    async signOut() {
      const cookie = await session.read();
      try {
        if (cookie) {
          await doFetch(`${baseUrl}/api/auth/sign-out`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: "{}",
          });
        }
      } finally {
        await session.clear();
      }
    },

    async hasSession() {
      return (await session.read()) !== null;
    },

    me() {
      return request("/m/me", meResponseSchema);
    },

    async listBots() {
      const result = await request("/m/bots", botsResponseSchema);
      return result.bots;
    },

    async getBot(botId) {
      const result = await request(`/m/bots/${encodeURIComponent(botId)}`, botResponseSchema);
      return result.bot;
    },

    async setAvatar(botId, avatar) {
      const result = await request(`/m/bots/${encodeURIComponent(botId)}`, botResponseSchema, {
        method: "PATCH",
        body: { avatar },
      });
      return result.bot;
    },

    messages(botId) {
      return request(`/m/bots/${encodeURIComponent(botId)}/messages`, conversationMessagesSchema);
    },

    sendMessage(conversationId, text) {
      return request(`/conversations/${encodeURIComponent(conversationId)}/messages`, sendMessageResponseSchema, {
        method: "POST",
        body: { text },
      });
    },

    async streamRun(runId, streamOptions) {
      let after = streamOptions.after ?? 0;
      let status = "unknown";
      let dropsWithoutProgress = 0;

      for (;;) {
        const resumedFrom = after;
        let terminal = false;

        try {
          const cookie = await session.read();
          const response = await doFetch(`${baseUrl}/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
            headers: {
              accept: "text/event-stream",
              ...(cookie ? { cookie } : {}),
            },
            ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
          });

          if (response.status === 401) {
            await session.clear();
            options.onUnauthorized?.();
            throw new UnauthorizedError();
          }
          if (!response.ok) {
            throw new ApiError(response.status, "stream_failed", `The reply could not be opened (${response.status}).`);
          }
          if (!response.body) throw new StreamUnsupportedError();

          for await (const frame of readSseEvents(response.body)) {
            if (frame.event === "open") continue;
            if (frame.event === "done") {
              const payload = safeJson(frame.data) as { status?: string } | null;
              return { status: payload?.status ?? "done" };
            }
            if (frame.event === "error") {
              const payload = safeJson(frame.data) as { message?: string } | null;
              throw new ApiError(502, "run_error", payload?.message ?? "The reply stopped unexpectedly.");
            }

            const event = safeJson(frame.data) as RunEvent | null;
            if (!event || typeof event.type !== "string") continue;
            if (typeof event.seq === "number") after = Math.max(after, event.seq);
            streamOptions.onEvent(event);
            if (event.type === "run.completed") {
              terminal = true;
              status = typeof event.payload.status === "string" ? event.payload.status : "done";
            }
          }
        } catch (error) {
          // An abort is the caller's decision. A 401 or a run error is the
          // server's. Everything else is a dropped socket, and the replay log
          // can be resumed from the last sequence we saw.
          if (isAbortError(error, streamOptions.signal)) throw error;
          if (error instanceof ApiError || error instanceof StreamUnsupportedError) throw error;
        }

        if (terminal) return { status };

        // Progress resets the budget: a long reply that an intermediary keeps
        // closing is still making headway. Only idle drops count against it.
        if (after > resumedFrom) {
          dropsWithoutProgress = 0;
        } else {
          dropsWithoutProgress += 1;
          if (dropsWithoutProgress > STREAM_RECONNECTS) {
            throw new ApiError(
              502,
              "stream_incomplete",
              "The reply stopped before it finished. Reopen the chat to pick it up.",
            );
          }
        }
      }
    },
  };
}

function isAbortError(error: unknown, signal: unknown): boolean {
  if (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError") return true;
  return typeof signal === "object" && signal !== null && (signal as { aborted?: boolean }).aborted === true;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
