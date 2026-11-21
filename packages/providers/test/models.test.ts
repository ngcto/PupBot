import { afterEach, describe, expect, it, vi } from "vitest";
import { listEndpointModels, ModelListingError } from "../src/models.ts";
import { jsonResponse } from "./helpers.ts";

const endpoint = {
  kind: "openai-chat" as const,
  baseUrl: "https://api.example.test/v1",
  apiKey: "sk-fixture",
  model: "fixture-model",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listEndpointModels", () => {
  it("reads an OpenAI-compatible list and normalises it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.example.test/v1/models");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-fixture");
        return jsonResponse({
          data: [
            { id: "b-model", owned_by: "acme", created: 1 },
            { id: "a-model", owned_by: "acme", created: 2 },
            { nope: true },
          ],
        });
      }),
    );

    const result = await listEndpointModels(endpoint);
    expect(result.models).toEqual([
      { id: "a-model", ownedBy: "acme", created: 2 },
      { id: "b-model", ownedBy: "acme", created: 1 },
    ]);
    expect(Date.parse(result.fetchedAt)).toBeGreaterThan(0);
  });

  it("records the endpoint's ETag and sends it back on the next refresh", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ data: [{ id: "a-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json", etag: 'W/"v1"' },
        });
      }),
    );

    const first = await listEndpointModels(endpoint);
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('W/"v1"');
    expect(first.models).toEqual([{ id: "a-model" }]);
    expect(seen[0]?.["if-none-match"]).toBeUndefined();

    await listEndpointModels(endpoint, { etag: first.etag });
    expect(seen[1]?.["if-none-match"]).toBe('W/"v1"');
  });

  it("treats a 304 as 'unchanged', never as 'this provider lists nothing'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(null, { status: 304 });
      }),
    );

    const result = await listEndpointModels(endpoint, { etag: 'W/"v1"' });
    expect(result.notModified).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.etag).toBe('W/"v1"');
  });

  it("does not treat a 304 without a validator as unchanged", async () => {
    // A 304 we did not ask for is not an answer we can use; it must not silently
    // wipe a cached list.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 304 })),
    );

    await expect(listEndpointModels(endpoint)).rejects.toBeInstanceOf(ModelListingError);
  });

  it("reads Anthropic's list shape with its own headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.anthropic.com/v1/models");
        const headers = init.headers as Record<string, string>;
        expect(headers["x-api-key"]).toBe("sk-ant-fixture");
        expect(headers["anthropic-version"]).toBeTruthy();
        return jsonResponse({
          data: [{ id: "claude-fixture", type: "model", created_at: "2026-01-02T03:04:05Z" }],
        });
      }),
    );

    const result = await listEndpointModels({
      kind: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-fixture",
      model: "claude-fixture",
    });
    expect(result.models[0]).toMatchObject({ id: "claude-fixture", ownedBy: "model" });
    expect(result.models[0]?.created).toBe(Date.parse("2026-01-02T03:04:05Z") / 1000);
  });

  it("reports a missing listing as no_model_listing, not a hard failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(listEndpointModels(endpoint)).rejects.toMatchObject({
      code: "no_model_listing",
      status: 404,
    });
  });

  it("maps auth and rate-limit failures onto our codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "no" } }, 401)));
    await expect(listEndpointModels(endpoint)).rejects.toMatchObject({ code: "auth", status: 401 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { type: "rate_limit_error", message: "slow" } }, 429)),
    );
    await expect(listEndpointModels(endpoint)).rejects.toMatchObject({ code: "rate_limit" });
  });

  it("times an unresponsive endpoint out instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    await expect(listEndpointModels(endpoint, { timeoutMs: 20 })).rejects.toBeInstanceOf(ModelListingError);
    await expect(listEndpointModels(endpoint, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });
});
