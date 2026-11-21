import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDERS,
  builtinForBaseUrl,
  builtinNeedsKey,
  builtinProvider,
  builtinRequestHeaders,
  isBuiltinId,
} from "../src/builtins.ts";

describe("built-in provider table", () => {
  it("holds the four providers Ng asked for, each with a fixed URL and a wire format", () => {
    expect(BUILTIN_PROVIDERS.map((provider) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "vercel-ai-gateway",
      "ollama-cloud",
    ]);
    for (const provider of BUILTIN_PROVIDERS) {
      expect(provider.baseUrl).toMatch(/^https:\/\//);
      expect(provider.baseUrl.endsWith("/"), provider.id).toBe(false);
      expect(provider.kind).toBe("openai-chat");
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.keyHint.length).toBeGreaterThan(0);
    }
  });

  it("carries the documented base URLs, not a guess", () => {
    expect(builtinProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(builtinProvider("opencode-go")?.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(builtinProvider("vercel-ai-gateway")?.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
    expect(builtinProvider("ollama-cloud")?.baseUrl).toBe("https://ollama.com/v1");
  });

  it("keeps every base URL unique, and one id per URL", () => {
    const urls = new Set(BUILTIN_PROVIDERS.map((provider) => provider.baseUrl));
    const ids = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id));
    expect(urls.size).toBe(BUILTIN_PROVIDERS.length);
    expect(ids.size).toBe(BUILTIN_PROVIDERS.length);
  });

  it("resolves a saved row by id, tolerantly of a trailing slash in a URL", () => {
    expect(builtinProvider("ollama-cloud")?.name).toBe("Ollama Cloud");
    expect(builtinProvider("custom-endpoint")).toBeUndefined();
    expect(builtinProvider(null)).toBeUndefined();
    expect(builtinForBaseUrl("https://openrouter.ai/api/v1/")?.id).toBe("openrouter");
    expect(builtinForBaseUrl(" https://AI-GATEWAY.VERCEL.SH/v1 ")?.id).toBe("vercel-ai-gateway");
    expect(builtinForBaseUrl("https://api.openai.com/v1")).toBeUndefined();
    expect(isBuiltinId("openrouter")).toBe(true);
    expect(isBuiltinId("")).toBe(false);
  });
});

describe("headers a built-in needs", () => {
  it("sends OpenCode Go's required session header and a real user agent", () => {
    const headers = builtinRequestHeaders(builtinProvider("opencode-go"), {
      session: "conversation-abc",
      userAgent: "terabot/1.0",
    });
    expect(headers).toEqual({
      "x-opencode-session": "conversation-abc",
      "user-agent": "terabot/1.0",
    });
  });

  it("adds nothing when the caller has no session, never a made-up one", () => {
    expect(builtinRequestHeaders(builtinProvider("opencode-go"))).toEqual({});
  });

  it("sends nothing extra for a provider whose docs do not require it", () => {
    for (const id of ["openrouter", "vercel-ai-gateway", "ollama-cloud"]) {
      expect(builtinRequestHeaders(builtinProvider(id), { session: "s", userAgent: "ua" }), id).toEqual({});
    }
    expect(builtinRequestHeaders(undefined, { session: "s" })).toEqual({});
  });
});

describe("a built-in without a key", () => {
  it("is excluded from bot creation until it holds a key", () => {
    expect(builtinNeedsKey({ builtinId: "openrouter", hasKey: false })).toBe(true);
    expect(builtinNeedsKey({ builtinId: "openrouter", hasKey: true })).toBe(false);
  });

  it("does not block a keyless endpoint that is not a built-in", () => {
    // The dev stub has no key by design and the AI Gateway is authenticated by
    // the deployment's own credentials.
    expect(builtinNeedsKey({ builtinId: null, hasKey: false })).toBe(false);
    expect(builtinNeedsKey({ builtinId: undefined, hasKey: false })).toBe(false);
  });
});
