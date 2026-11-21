import { describe, expect, it } from "vitest";
import { InstaboxClient, InstaboxProvider, ProviderError, providerErrorFrom } from "../src/index.ts";
import type { InstaboxMachine } from "../src/index.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function stubFetch(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const reply = routes(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const machine = (overrides: Partial<InstaboxMachine> = {}): InstaboxMachine => ({
  id: "box-1",
  name: "box-1",
  state: "running",
  runtime: { ready: true },
  spec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
  autoSuspendAfterSeconds: 1800,
  maxRunMinutes: 480,
  createdAt: "2026-11-20T00:00:00Z",
  ...overrides,
});

const operation = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "op-1",
  machineId: "box-1",
  type: "create",
  state,
  ...extra,
});

describe("instabox error taxonomy", () => {
  const cases: Array<[number, string, string, boolean | undefined]> = [
    [429, "quota_exceeded", "quota", false],
    [429, "rate_limited", "rate_limited", true],
    [503, "no_capacity", "no_capacity", true],
    [503, "host_unavailable", "unavailable", true],
    [403, "template_not_allowed", "template_refused", false],
    [400, "spec_not_allowed", "template_refused", false],
    [401, "invalid_key", "auth", false],
    [403, "missing_scope", "auth", false],
    [404, "not_found", "not_found", false],
    [409, "machine_not_running", "not_running", false],
    [409, "operation_conflict", "busy", true],
    [409, "machine_cooldown", "busy", true],
    [400, "unknown_field", "bad_request", false],
    [500, "internal", "unavailable", true],
    [418, "quirky", "unknown", false],
  ];

  for (const [status, code, expected, retryable] of cases) {
    it(`maps ${status} ${code} to ${expected}`, () => {
      const error = providerErrorFrom(status, { code, message: "detail", retryable });
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.code).toBe(expected);
      expect(error.providerCode).toBe(code);
      expect(error.retryable).toBe(retryable ?? error.retryable);
    });
  }

  it("keeps retryAfterSeconds from the API", () => {
    const error = providerErrorFrom(429, { code: "rate_limited", retryable: true, retryAfterSeconds: 60 });
    expect(error.retryAfterSeconds).toBe(60);
  });

  it("falls back to the status when the body has no code", () => {
    expect(providerErrorFrom(404, undefined).code).toBe("not_found");
    expect(providerErrorFrom(502, undefined).code).toBe("unavailable");
  });
});

describe("instabox provider against a stubbed API", () => {
  it("provisions with an idempotency key, waits for the operation, then for ready", async () => {
    const { impl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/v1/machines") && call.method === "POST") return { status: 202, body: operation("queued") };
      if (call.url.includes("/v1/operations/op-1")) return { status: 200, body: operation("succeeded") };
      if (call.url.includes("/v1/machines/box-1") && call.method === "GET") {
        return { status: 200, body: machine({ runtime: { ready: true, processesPreserved: true } }) };
      }
      return { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    });

    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    const ref = await provider.provision({ metadata: { botId: "bot-1" }, ttlSeconds: 3600 });

    expect(ref).toEqual({ provider: "instabox", account: "acct-1", id: "box-1" });
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/machines"))!;
    expect(create.headers["Idempotency-Key"]).toBeTruthy();
    expect(create.headers["X-API-Key"]).toBe("ibk_test");
    const body = JSON.parse(create.body!) as Record<string, unknown>;
    expect(body.templateId).toBe("agent-browser");
    expect(body.deleteAfterSeconds).toBe(3600);
    expect(body.metadata).toEqual({ botId: "bot-1" });
  });

  it("cleans up a half-created box when the create operation fails", async () => {
    const { impl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/v1/machines") && call.method === "POST") return { status: 202, body: operation("queued") };
      if (call.url.includes("/v1/operations/op-1")) {
        return {
          status: 200,
          body: operation("failed", {
            error: { code: "no_capacity", message: "no host has room", retryable: true, retryAfterSeconds: 60 },
          }),
        };
      }
      if (call.url.includes("/v1/machines/box-1") && call.method === "DELETE") {
        return { status: 202, body: operation("succeeded") };
      }
      return { status: 200, body: operation("succeeded") };
    });

    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    await expect(provider.provision()).rejects.toMatchObject({ code: "no_capacity", retryAfterSeconds: 60 });

    const del = calls.find((call) => call.method === "DELETE");
    expect(del?.url).toContain("/v1/machines/box-1");
    expect(del?.headers["X-Confirm-Delete"]).toBe("box-1");
    expect(del?.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("reports exec on a suspended box as not_running, never a wake", async () => {
    const { impl } = stubFetch(() => ({
      status: 409,
      body: { error: { code: "machine_not_running", message: "sandbox is suspended", retryable: false } },
    }));
    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    await expect(provider.exec({ provider: "instabox", account: "acct-1", id: "box-1" }, "true")).rejects.toMatchObject({
      code: "not_running",
    });
  });

  it("returns a non-zero exec as a result", async () => {
    const { impl } = stubFetch(() => ({
      status: 200,
      body: { stdout: "", stderr: "boom", exitCode: 3, timedOut: false, truncated: false },
    }));
    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    const result = await provider.exec({ provider: "instabox", account: "acct-1", id: "box-1" }, "false");
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, stderr: "boom" });
  });

  it("resumes a suspended box on start and waits for ready", async () => {
    const states = ["suspended", "running"];
    const { impl, calls } = stubFetch((call) => {
      if (call.url.includes("/resume") && call.method === "POST") return { status: 202, body: operation("queued") };
      if (call.url.includes("/v1/operations/op-1")) return { status: 200, body: operation("succeeded") };
      if (call.url.includes("/v1/machines/box-1") && call.method === "GET") {
        const next = states.length > 1 ? states.shift()! : states[0]!;
        return {
          status: 200,
          body: machine(next === "running" ? { runtime: { ready: true, processesPreserved: true } } : { state: next, runtime: { ready: false } }),
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    });

    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    const status = await provider.start({ provider: "instabox", account: "acct-1", id: "box-1" });

    expect(status.ready).toBe(true);
    expect(status.processesPreserved).toBe(true);
    expect(calls.some((call) => call.url.includes("/resume"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/start"))).toBe(false);
  });

  it("maps a failed operation's error body to a ProviderError", async () => {
    const { impl } = stubFetch((call) => {
      if (call.url.includes("/start")) return { status: 202, body: operation("queued") };
      if (call.url.includes("/v1/operations/op-1")) {
        return { status: 200, body: operation("failed", { error: { code: "quota_exceeded", message: "too many running" } }) };
      }
      return { status: 200, body: machine({ state: "stopped", runtime: { ready: false } }) };
    });
    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    await expect(provider.start({ provider: "instabox", account: "acct-1", id: "box-1" })).rejects.toMatchObject({
      code: "quota",
    });
  });
});

describe("instabox provider after review hardening", () => {
  it("parses a CRLF exec stream, even when the stream splits a CRLF pair", async () => {
    const chunks = [
      'event: stdout\r\ndata: {"data":"hel"}\r\n\r',
      '\nevent: stdout\r\ndata: {"data":"lo"}\r\n\r\n',
      'event: exit\r\ndata: {"stdout":"hello","stderr":"","exitCode":0,"timedOut":false,"truncated":false}\r\n\r\n',
    ];
    const impl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;

    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    const seen: string[] = [];
    const result = await provider.exec(
      { provider: "instabox", account: "acct-1", id: "box-1" },
      "echo hello",
      { onOutput: (chunk) => seen.push(chunk.text) },
    );

    expect(seen.join("")).toBe("hello");
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("sends a caller-supplied idempotency key instead of minting one per attempt", async () => {
    const { impl, calls } = stubFetch(() => ({ status: 202, body: operation("queued") }));
    const client = new InstaboxClient({ apiKey: "ibk_test", account: "acct-1", fetch: impl });

    await client.createMachine({}, { idempotencyKey: "retry-same-key" });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("retry-same-key");
  });

  it("waits for an in-flight operation before retrying a busy delete", async () => {
    let deletes = 0;
    const { impl, calls } = stubFetch((call) => {
      if (call.url.includes("/v1/machines/box-1") && call.method === "DELETE") {
        deletes += 1;
        return deletes === 1
          ? { status: 409, body: { error: { code: "operation_conflict", message: "an operation is running" } } }
          : { status: 202, body: operation("succeeded") };
      }
      if (call.url.includes("/v1/operations/op-1")) return { status: 200, body: operation("succeeded") };
      return { status: 200, body: machine({ state: "running", runtime: { ready: true } }) };
    });

    const provider = new InstaboxProvider({ account: "acct-1", apiKey: "ibk_test", fetch: impl });
    await provider.destroy({ provider: "instabox", account: "acct-1", id: "box-1" });

    expect(deletes).toBe(2);
    expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(0);
  });
});
