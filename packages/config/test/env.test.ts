import { describe, expect, it } from "vitest";
import { resetEnvCache, serverEnv } from "../src/env.ts";

const base = {
  DATABASE_URL: "postgres://pupbot:pupbot@localhost:5432/pupbot",
  BETTER_AUTH_SECRET: "x".repeat(40),
};

describe("serverEnv", () => {
  it("keeps the dev stub endpoint off unless the environment asks for it", () => {
    resetEnvCache();
    expect(serverEnv(base).STUB_PROVIDER).toBe(false);
    resetEnvCache();
    expect(serverEnv({ ...base, STUB_PROVIDER: "true" }).STUB_PROVIDER).toBe(true);
    resetEnvCache();
  });

  it("rejects an empty BETTER_AUTH_SECRET", () => {
    resetEnvCache();
    expect(() => serverEnv({ ...base, BETTER_AUTH_SECRET: "" })).toThrow(/BETTER_AUTH_SECRET/);
    resetEnvCache();
  });
});
