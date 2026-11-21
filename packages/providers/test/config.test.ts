import { describe, expect, it } from "vitest";
import { endpointConfigForRow, PROBE_SESSION, TERABOT_USER_AGENT } from "../src/config.ts";

const custom = {
  kind: "openai-chat" as const,
  baseUrl: "https://gateway.example.test/v1",
  model: "m",
  apiKey: "sk-test",
};

describe("endpointConfigForRow", () => {
  it("leaves a custom endpoint exactly as the row says", () => {
    const config = endpointConfigForRow(custom);
    expect(config).toEqual({
      kind: "openai-chat",
      baseUrl: "https://gateway.example.test/v1",
      model: "m",
      apiKey: "sk-test",
    });
  });

  it("takes a built-in's URL and wire format from the table, not the row", () => {
    // A row saved before the table existed, or one edited by hand, must still
    // reach the provider's real endpoint: the table is the authority.
    const config = endpointConfigForRow({
      kind: "openai-chat",
      baseUrl: "https://wrong.example.test/v1",
      builtinId: "openrouter",
      model: "openai/gpt-6-sol",
      apiKey: "sk-or-test",
    });
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.kind).toBe("openai-chat");
    expect(config.apiKey).toBe("sk-or-test");
    expect(config.headers).toBeUndefined();
  });

  it("adds OpenCode Go's required session header from the conversation", () => {
    const config = endpointConfigForRow({
      kind: "openai-chat",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      builtinId: "opencode-go",
      model: "deepseek-v4.1-flash",
      apiKey: "oc_sk_test",
      session: "conversation-7",
    });
    expect(config.headers).toEqual({
      "x-opencode-session": "conversation-7",
      "user-agent": TERABOT_USER_AGENT,
    });
  });

  it("sends the session only when there is one, and never invents a value", () => {
    const config = endpointConfigForRow({
      kind: "openai-chat",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      builtinId: "opencode-go",
      model: "m",
    });
    expect(config.headers?.["x-opencode-session"]).toBeUndefined();
    expect(config.headers?.["user-agent"]).toBe(TERABOT_USER_AGENT);
  });

  it("lets a stored header override a default one", () => {
    const config = endpointConfigForRow({
      ...custom,
      builtinId: "opencode-go",
      headers: { "user-agent": "my-agent/2.0" },
    });
    expect(config.headers?.["user-agent"]).toBe("my-agent/2.0");
  });

  it("names the probe session for a non-conversation call", () => {
    expect(PROBE_SESSION).not.toBe(TERABOT_USER_AGENT);
  });
});
