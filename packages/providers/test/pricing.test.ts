import { describe, expect, it } from "vitest";
import { costAsDecimal, costOf } from "../src/pricing.ts";

describe("costOf", () => {
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it("prices input and output per million tokens", () => {
    expect(costOf(pricing, { inputTokens: 1_000_000 })).toBeCloseTo(3, 10);
    expect(costOf(pricing, { outputTokens: 1_000_000 })).toBeCloseTo(15, 10);
    expect(costOf(pricing, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.0105, 10);
  });

  it("prices cache read and cache write separately", () => {
    expect(
      costOf(pricing, { inputTokens: 1000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000 }),
    ).toBeCloseTo(0.003 + 0.15 + 0.375, 10);
  });

  it("falls back to the input rate when a cache price is absent", () => {
    expect(costOf({ input: 2, output: 4 }, { cacheReadTokens: 1_000_000 })).toBeCloseTo(2, 10);
  });

  it("returns null instead of pretending an unknown model is free", () => {
    expect(costOf(null, { inputTokens: 10 })).toBeNull();
    expect(costOf(undefined, { inputTokens: 10 })).toBeNull();
    expect(costOf({ input: 3 }, { outputTokens: 10 })).toBeNull();
    expect(costOf(pricing, {})).toBeNull();
  });

  it("writes a fixed-precision decimal for the numeric column", () => {
    expect(costAsDecimal(0.0105)).toBe("0.010500");
    expect(costAsDecimal(null)).toBeNull();
  });
});
