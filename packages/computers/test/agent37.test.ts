import { describe, expect, it } from "vitest";
import {
  AGENT37_SANDBOX_URL,
  Agent37Client,
  Agent37Provider,
  ProviderError,
  agent37ErrorFrom,
  classifyAgent37,
} from "../src/index.ts";
import type { Agent37Instance } from "../src/index.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/**
 * A stub of Agent37's two planes. Every payload here follows the published
 * reference at https://www.agent37.com/docs/agents-api (the instance object,
 * lifecycle acks, the exec result and both error envelopes) — these are
 * docs-derived fixtures, not recorded traffic, and no Agent37 key exists on this
 * machine to record with.
 */
function stubAgent37(routes: (call: Call) => { status: number; body?: unknown } | Response) {
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
    if (reply instanceof Response) return reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const instance = (overrides: Partial<Agent37Instance> = {}): Agent37Instance => ({
  id: "ab12cd34ef",
  status: "running",
  template: "agent37-hermes",
  type: "default",
  region: "us",
  resources: { cpu: 2, memory: 4, disk: 4 },
  url: "https://ab12cd34ef.agent37.app",
  auto_sleep: false,
  idle_timeout_seconds: 900,
  created: 1781222400,
  ...overrides,
});

function provider(routes: (call: Call) => { status: number; body?: unknown } | Response) {
  const stub = stubAgent37(routes);
  const instanceProvider = new Agent37Provider({
    account: "agent37:test",
    apiKey: "example-not-a-real-agent37-key",
    fetch: stub.impl,
  });
  return { provider: instanceProvider, calls: stub.calls };
}

describe("agent37 — error taxonomy", () => {
  it("maps the documented Sandbox API codes onto the contract's vocabulary", () => {
    expect(classifyAgent37("invalid_api_key")).toBe("auth");
    expect(classifyAgent37("ip_not_allowed")).toBe("auth");
    expect(classifyAgent37("insufficient_balance")).toBe("quota");
    expect(classifyAgent37("instance_limit_reached")).toBe("quota");
    expect(classifyAgent37("no_capacity")).toBe("no_capacity");
    expect(classifyAgent37("capacity_unavailable")).toBe("no_capacity");
    expect(classifyAgent37("try_again")).toBe("busy");
    expect(classifyAgent37("not_found")).toBe("not_found");
    expect(classifyAgent37("template_conflict")).toBe("template_refused");
    expect(classifyAgent37("provisioning_failed")).toBe("unavailable");
    expect(classifyAgent37("rate_limited")).toBe("rate_limited");
  });

  it("reads the nested envelope", () => {
    const error = agent37ErrorFrom(402, {
      error: { code: "insufficient_balance", message: "This instance costs $0.0068 per hour" },
    });
    expect(error.code).toBe("quota");
    expect(error.retryable).toBe(false);
    expect(error.providerCode).toBe("insufficient_balance");
    expect(error.status).toBe(402);
  });

  it("reads the flat transport envelope, where `error` is a bare string", () => {
    // The docs are explicit: on the instance plane a rejection before the
    // gateway answers `{ "error": "not_found" }`, so `error` must be checked for
    // being a string before `code` is read.
    const error = agent37ErrorFrom(404, { error: "not_found" });
    expect(error.code).toBe("not_found");
    expect(error.providerCode).toBe("not_found");

    const suspended = agent37ErrorFrom(402, { error: "instance_suspended" });
    expect(suspended.code).toBe("quota");
  });

  it("keeps an unknown code as unknown rather than guessing a remedy", () => {
    const error = agent37ErrorFrom(502, { error: { code: "quota_exhausted", message: "budget spent" } });
    expect(error.code).toBe("unknown");
    expect(error.providerCode).toBe("quota_exhausted");
  });

  it("marks the transient codes retryable and the permanent ones not", () => {
    expect(agent37ErrorFrom(503, { error: { code: "no_capacity" } }).retryable).toBe(true);
    expect(agent37ErrorFrom(409, { error: { code: "try_again" } }).retryable).toBe(true);
    expect(agent37ErrorFrom(401, { error: { code: "invalid_api_key" } }).retryable).toBe(false);
    expect(agent37ErrorFrom(409, { error: { code: "instance_limit_reached" } }).retryable).toBe(false);
  });
});

describe("agent37 — lifecycle", () => {
  it("creates with the documented body and resolves once the instance is running", async () => {
    const { provider: box, calls } = provider((call) => {
      if (call.method === "POST" && call.url.endsWith("/v1/instances")) {
        return { status: 201, body: instance() };
      }
      return { status: 200, body: instance() };
    });

    const ref = await box.provision({ metadata: { terabot: "1", botId: "bot-1" } });
    expect(ref.id).toBe("ab12cd34ef");
    expect(ref.provider).toBe("agent37");

    const create = calls.find((call) => call.method === "POST")!;
    const body = JSON.parse(create.body!);
    expect(body.template).toBe("agent37-hermes");
    expect(body.metadata).toEqual({ terabot: "1", botId: "bot-1" });
    // Agent37 has no delete-after field, so a leaked box is bounded by auto-sleep
    // at the provider's maximum idle window: it stops billing compute by itself.
    expect(body.auto_sleep).toBe(true);
    expect(body.idle_timeout_seconds).toBe(86_400);
    // The control plane authenticates with a Bearer token, and the key is never
    // in the URL.
    expect(create.headers.authorization).toBe("Bearer example-not-a-real-agent37-key");
    expect(create.url).not.toContain("example-not-a-real-agent37-key");
  });

  it("lets a deployment turn the leak backstop off and own the sleep itself", async () => {
    const stub = stubAgent37(() => ({ status: 201, body: instance() }));
    const box = new Agent37Provider({
      account: "agent37:test",
      apiKey: "example-not-a-real-agent37-key",
      fetch: stub.impl,
      leakBackstop: false,
    });
    await box.provision();
    const body = JSON.parse(stub.calls.find((call) => call.method === "POST")!.body!);
    expect(body.auto_sleep).toBeUndefined();
    expect(body.idle_timeout_seconds).toBeUndefined();
  });

  it("wakes a stopped instance through start, and start is the only wake path used", async () => {
    let state = "stopped";
    const { provider: box, calls } = provider((call) => {
      if (call.method === "POST" && call.url.endsWith("/start")) {
        state = "running";
        return { status: 200, body: { id: "ab12cd34ef", status: "running" } };
      }
      return { status: 200, body: instance({ status: state }) };
    });

    const status = await box.start({ provider: "agent37", account: "agent37:test", id: "ab12cd34ef" });
    expect(status.state).toBe("running");
    expect(status.ready).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/start"))).toBe(true);
  });

  it("treats a sleeping instance as memory-preserving and a stopped one as not", async () => {
    const sleeping = provider(() => ({ status: 200, body: instance({ status: "sleeping", slept_at: 1781222400 }) }));
    const status = await sleeping.provider.status({ provider: "agent37", account: "a", id: "ab12cd34ef" });
    expect(status.state).toBe("sleeping");
    expect(status.ready).toBe(false);
    expect(status.processesPreserved).toBe(true);
    expect(status.autoSleptAt).toBe(new Date(1781222400 * 1000).toISOString());

    const stopped = provider(() => ({ status: 200, body: instance({ status: "stopped" }) }));
    const memoryless = await stopped.provider.status({ provider: "agent37", account: "a", id: "ab12cd34ef" });
    expect(memoryless.state).toBe("stopped");
    // A stopped instance lost its memory, so it must not claim to have kept it.
    expect(memoryless.processesPreserved).toBeUndefined();
  });

  it("sleeps a running instance and leaves an already-sleeping one alone", async () => {
    let sleepCalls = 0;
    const running = provider((call) => {
      if (call.url.endsWith("/sleep")) {
        sleepCalls += 1;
        return { status: 200, body: { id: "ab12cd34ef", status: "sleeping" } };
      }
      return { status: 200, body: instance({ status: sleepCalls > 0 ? "sleeping" : "running" }) };
    });
    const slept = await running.provider.sleep({ provider: "agent37", account: "a", id: "ab12cd34ef" });
    expect(slept.state).toBe("sleeping");
    expect(slept.ready).toBe(false);
    expect(sleepCalls).toBe(1);

    const already = provider(() => ({ status: 200, body: instance({ status: "sleeping" }) }));
    const again = await already.provider.sleep({ provider: "agent37", account: "a", id: "ab12cd34ef" });
    expect(again.state).toBe("sleeping");
    expect(already.calls.some((call) => call.url.endsWith("/sleep"))).toBe(false);
  });

  it("destroys, and destroying an already-deleted instance resolves", async () => {
    let deleted = false;
    const { provider: box } = provider((call) => {
      if (call.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 200 });
      }
      if (deleted) return { status: 404, body: { error: { code: "not_found", message: "no instance" } } };
      return { status: 200, body: instance() };
    });

    await box.destroy({ provider: "agent37", account: "a", id: "ab12cd34ef" });
    await expect(box.destroy({ provider: "agent37", account: "a", id: "ab12cd34ef" })).resolves.toBeUndefined();
  });

  it("does not report a successful destroy when the delete was refused", async () => {
    // A delete that failed silently would leave the instance billing disk while
    // the caller believed it was gone.
    const { provider: box } = provider((call) => {
      if (call.method === "DELETE") {
        return { status: 401, body: { error: { code: "invalid_api_key", message: "key revoked" } } };
      }
      return { status: 200, body: instance() };
    });

    await expect(box.destroy({ provider: "agent37", account: "a", id: "ab12cd34ef" })).rejects.toMatchObject({
      code: "auth",
      providerCode: "invalid_api_key",
    });
  });

  it("throws not_found for an instance that no longer resolves", async () => {
    const { provider: box } = provider(() => ({
      status: 404,
      body: { error: { code: "not_found", message: "no such instance" } },
    }));
    await expect(box.status({ provider: "agent37", account: "a", id: "gone" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("agent37 — exec", () => {
  it("runs a command on the instance plane with the sandbox key header", async () => {
    const { provider: box, calls } = provider((call) => {
      if (call.url.includes("/exec")) {
        return { status: 200, body: { exit_code: 0, stdout: "v24.2.0\n", stderr: "", truncated: false } };
      }
      return { status: 200, body: instance() };
    });

    const result = await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "node --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v24.2.0");

    const exec = calls.find((call) => call.url.includes("/exec"))!;
    expect(exec.url.startsWith(AGENT37_SANDBOX_URL)).toBe(true);
    // The instance plane takes the key as a header, not a Bearer token.
    expect(exec.headers["x-agent37-key"]).toBe("example-not-a-real-agent37-key");
    expect(exec.headers.authorization).toBeUndefined();
  });

  it("returns a non-zero exit as a result, not an exception", async () => {
    const { provider: box } = provider(() => ({
      status: 200,
      body: { exit_code: 7, stdout: "", stderr: "boom", truncated: false },
    }));
    const result = await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "exit 7");
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("honours a timeout by wrapping the command, since the API has no timeout field", async () => {
    const { provider: box, calls } = provider(() => ({
      status: 200,
      body: { exit_code: 124, stdout: "", stderr: "", truncated: false },
    }));
    const result = await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "sleep 100", {
      timeoutSeconds: 5,
    });
    expect(result.timedOut).toBe(true);
    const exec = calls.find((call) => call.url.includes("/exec"))!;
    const sent = JSON.parse(exec.body!).command as string;
    expect(sent.startsWith("timeout 5s sh -c ")).toBe(true);
  });

  it("passes cwd and env into the instance's shell, with env applying to the command", async () => {
    const { provider: box, calls } = provider(() => ({
      status: 200,
      body: { exit_code: 0, stdout: "", stderr: "", truncated: false },
    }));
    await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "pwd", {
      cwd: "/home/node/app",
      env: { NODE_ENV: "test" },
    });
    const sent = JSON.parse(calls.find((call) => call.url.includes("/exec"))!.body!).command as string;
    // A `KEY=v cmd` prefix would scope the variable to `cd` alone, leaving the
    // real command without it, so the export must come first and the cd after.
    expect(sent).toBe("cd '/home/node/app' && export NODE_ENV='test'; pwd");
    expect(sent.indexOf("export NODE_ENV")).toBeGreaterThan(sent.indexOf("cd "));
  });

  it("keeps env applying to a compound command, not only its first word", async () => {
    const { provider: box, calls } = provider(() => ({
      status: 200,
      body: { exit_code: 0, stdout: "", stderr: "", truncated: false },
    }));
    await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "a && b", {
      env: { FLAG: "1" },
    });
    const sent = JSON.parse(calls.find((call) => call.url.includes("/exec"))!.body!).command as string;
    // An export is what reaches both halves of an && chain.
    expect(sent.startsWith("export FLAG='1'; ")).toBe(true);
  });

  it("reports truncation instead of pretending it got the whole output", async () => {
    const { provider: box } = provider(() => ({
      status: 200,
      body: { exit_code: 0, stdout: "…cut…", stderr: "", truncated: true },
    }));
    const result = await box.exec({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "cat big.log");
    expect(result.truncated).toBe(true);
  });
});

describe("agent37 — files", () => {
  it("writes bytes to the instance's file API with the raw body", async () => {
    const { provider: box, calls } = provider((call) => {
      if (call.url.includes("/v1/files/content")) {
        return {
          status: 200,
          body: { name: "note.txt", path: "/home/node/note.txt", type: "file", size: 5, modified: 1781049642000 },
        };
      }
      return { status: 200, body: instance() };
    });

    await box.putFile({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "/home/node/note.txt", "hello");
    const write = calls.find((call) => call.url.includes("/v1/files/content"))!;
    expect(write.method).toBe("PUT");
    expect(write.url).toContain("path=%2Fhome%2Fnode%2Fnote.txt");
    expect(write.headers["x-agent37-key"]).toBe("example-not-a-real-agent37-key");
  });

  it("reads bytes back from the file API", async () => {
    const { provider: box } = provider((call) => {
      if (call.url.includes("/v1/files/content")) {
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return { status: 200, body: instance() };
    });

    const bytes = await box.getFile({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "/home/node/note.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("lists a directory with Agent37's entry shape", async () => {
    const { provider: box } = provider((call) => {
      if (call.url.includes("/v1/files?")) {
        return {
          status: 200,
          body: {
            path: "/home/node",
            parentPath: "/home",
            entries: [
              { name: "reports", path: "/home/node/reports", type: "directory", size: null, modified: 1781049600000, hidden: false },
              { name: "leads.csv", path: "/home/node/leads.csv", type: "file", size: 18244, modified: 1781049642000, hidden: false },
            ],
            truncated: false,
          },
        };
      }
      return { status: 200, body: instance() };
    });

    const entries = await box.list({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "/home/node");
    expect(entries).toHaveLength(2);
    // `directory` on the wire is `dir` in the contract.
    expect(entries[0]).toMatchObject({ name: "reports", type: "dir", size: 0 });
    expect(entries[1]).toMatchObject({ name: "leads.csv", type: "file", size: 18244 });
    expect(entries[1]?.modifiedAt).toBe(new Date(1781049642000).toISOString());
  });

  it("says a template has no file API rather than returning an empty directory", async () => {
    const { provider: box } = provider(() => ({ status: 200, body: instance({ template: "agent37-base" }) }));
    await expect(
      box.list({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "/home/node"),
    ).rejects.toMatchObject({ providerCode: "unsupported" });
  });

  it("keeps the computer when a path is missing, so the allocator does not replace it", async () => {
    // `not_found` on the instance plane means a missing file. The allocator reads
    // `not_found` as "the computer is gone", so the provider must not pass it on.
    const { provider: box } = provider((call) => {
      if (call.url.includes("/v1/files/content")) {
        return { status: 404, body: { error: { code: "file_not_found", message: "no file" } } };
      }
      return { status: 200, body: instance() };
    });

    const error = await box
      .getFile({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "/home/node/missing.txt")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("bad_request");
    expect((error as ProviderError).providerCode).toBe("file_not_found");
  });
});

describe("agent37 — capabilities the contract asks for", () => {
  it("refuses a screenshot by name instead of no-oping", async () => {
    const { provider: box } = provider(() => ({ status: 200, body: instance() }));
    const error = await box
      .screenshot({ provider: "agent37", account: "a", id: "ab12cd34ef" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).providerCode).toBe("unsupported");
    expect((error as ProviderError).message).toContain("screenshot");
  });

  it("keeps a box awake by touching it, because there is no lease object", async () => {
    const { provider: box, calls } = provider((call) => {
      if (call.url.includes("/exec")) {
        return { status: 200, body: { exit_code: 0, stdout: "", stderr: "", truncated: false } };
      }
      return { status: 200, body: instance() };
    });

    const lease = await box.lease({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "task-1", 60);
    expect(lease.id).toBe("task-1");
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
    // Activity on the instance is what resets Agent37's idle timer, so a lease
    // is an exec; releasing one has nothing to undo.
    expect(calls.some((call) => call.url.includes("/exec"))).toBe(true);
    await expect(
      box.releaseLease({ provider: "agent37", account: "a", id: "ab12cd34ef" }, "task-1"),
    ).resolves.toBeUndefined();
  });

  it("lists the workspace's instances and carries metadata for reconcile", async () => {
    const { provider: box } = provider(() => ({
      status: 200,
      body: {
        data: [
          instance({ id: "one", metadata: { terabot: "1", botId: "bot-1" } }),
          instance({ id: "two", status: "sleeping", metadata: null }),
        ],
      },
    }));

    const boxes = await box.listComputers();
    expect(boxes.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(boxes[0]?.metadata).toEqual({ terabot: "1", botId: "bot-1" });
    expect(boxes[1]?.status.state).toBe("sleeping");
  });
});

describe("agent37 — the client itself", () => {
  it("never puts the key in a URL", async () => {
    const stub = stubAgent37(() => ({ status: 200, body: { data: [] } }));
    const client = new Agent37Client({ apiKey: "example-not-a-real-agent37-key", account: "a", fetch: stub.impl });
    await client.listInstances();
    for (const call of stub.calls) expect(call.url).not.toContain("example-not-a-real-agent37-key");
  });

  it("reports a timeout as a timeout, not an unavailable", async () => {
    // A real fetch rejects with an AbortError when its signal aborts; this stub
    // does the same, because a stub that ignores the signal would only prove the
    // stub ignores the signal.
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;
    const client = new Agent37Client({ apiKey: "k", account: "a", fetch: impl });
    await expect(client.getInstance("x", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("treats a caller's own abort as unavailable, not as a provider timeout", async () => {
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;
    const client = new Agent37Client({ apiKey: "k", account: "a", fetch: impl });
    const controller = new AbortController();
    const pending = client.getInstance("x", { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toMatchObject({ code: "unavailable", providerCode: "aborted" });
  });
});
