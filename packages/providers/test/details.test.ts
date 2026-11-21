import { describe, expect, it } from "vitest";
import { fillMissingDetails, isSet, sourcesAfterUserEdit } from "../src/details.ts";

const CATALOGUE = {
  contextWindow: 200_000,
  pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  toolSupport: true,
  reasoning: true,
};

describe("gap-only metadata population", () => {
  it("fills every field of an endpoint that has no details yet", () => {
    const fill = fillMissingDetails({}, CATALOGUE);
    expect(fill.details).toEqual(CATALOGUE);
    expect(fill.autoFilled).toEqual(["contextWindow", "pricing", "toolSupport", "reasoning"]);
  });

  it("keeps a context window the user set by hand", () => {
    // The regression this rule exists for: models.dev says 200k for this id, the
    // user knows their gateway serves 32k, and the fill must not undo their entry.
    const fill = fillMissingDetails({ contextWindow: 32_000 }, CATALOGUE);
    expect(fill.details.contextWindow).toBe(32_000);
    expect(fill.details.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(fill.autoFilled).not.toContain("contextWindow");
    expect(fill.autoFilled).toContain("pricing");
  });

  it("keeps pricing the user set by hand, whole or in part", () => {
    const whole = fillMissingDetails({ pricing: { input: 1, output: 2 } }, CATALOGUE);
    expect(whole.details.pricing).toEqual({ input: 1, output: 2 });
    expect(whole.autoFilled).not.toContain("pricing");

    // A partial price is still a price the user typed: filling the rest would
    // silently mix two sources in one number the UI shows as theirs.
    const partial = fillMissingDetails({ pricing: { input: 1 } }, CATALOGUE);
    expect(partial.details.pricing).toEqual({ input: 1 });
  });

  it("keeps capabilities the user set by hand, including a deliberate false", () => {
    const fill = fillMissingDetails({ toolSupport: false, reasoning: false }, CATALOGUE);
    expect(fill.details.toolSupport).toBe(false);
    expect(fill.details.reasoning).toBe(false);
    expect(fill.autoFilled).not.toContain("toolSupport");
    expect(fill.autoFilled).not.toContain("reasoning");
  });

  it("keeps every hand-set field at once, and fills only the rest", () => {
    const mine = { contextWindow: 128_000, pricing: { input: 0.5 }, toolSupport: false };
    const fill = fillMissingDetails(mine, CATALOGUE);
    expect(fill.details.contextWindow).toBe(128_000);
    expect(fill.details.pricing).toEqual({ input: 0.5 });
    expect(fill.details.toolSupport).toBe(false);
    expect(fill.details.reasoning).toBe(true);
    expect(fill.autoFilled).toEqual(["reasoning"]);
  });

  it("treats a null, a zero and a non-number as unset, so they may be filled", () => {
    const fill = fillMissingDetails(
      { contextWindow: null, pricing: null, toolSupport: null, reasoning: undefined },
      CATALOGUE,
    );
    expect(fill.autoFilled).toEqual(["contextWindow", "pricing", "toolSupport", "reasoning"]);
  });

  it("leaves an unmatched model exactly as it was", () => {
    const mine = { contextWindow: 32_000 };
    const fill = fillMissingDetails(mine, null);
    expect(fill.details).toEqual(mine);
    expect(fill.autoFilled).toEqual([]);
  });

  it("fills nothing from a catalogue entry whose fields are all empty", () => {
    const empty = { contextWindow: null, pricing: {}, toolSupport: null, reasoning: null };
    const fill = fillMissingDetails({}, empty);
    expect(fill.details).toEqual({});
    expect(fill.autoFilled).toEqual([]);
  });

  it("does not mutate the details it was handed", () => {
    const mine = { contextWindow: 32_000 };
    fillMissingDetails(mine, CATALOGUE);
    expect(mine).toEqual({ contextWindow: 32_000 });
  });
});

describe("isSet", () => {
  it("counts a usable number as set and a null, zero, negative or string as not", () => {
    expect(isSet("contextWindow", 128_000)).toBe(true);
    expect(isSet("contextWindow", null)).toBe(false);
    expect(isSet("contextWindow", undefined)).toBe(false);
    expect(isSet("contextWindow", 0)).toBe(false);
    expect(isSet("contextWindow", -1)).toBe(false);
    expect(isSet("contextWindow", Number.NaN)).toBe(false);
    expect(isSet("contextWindow", "128000")).toBe(false);
  });

  it("counts a price with one numeric rate as set, a free price included", () => {
    expect(isSet("pricing", { input: 0 })).toBe(true);
    expect(isSet("pricing", {})).toBe(false);
    expect(isSet("pricing", null)).toBe(false);
  });

  it("counts a boolean as set either way, and only null as unset", () => {
    expect(isSet("toolSupport", false)).toBe(true);
    expect(isSet("toolSupport", true)).toBe(true);
    expect(isSet("toolSupport", null)).toBe(false);
  });
});

describe("where a value came from", () => {
  it("marks only the fields the fill took, not the ones the user set", () => {
    const fill = fillMissingDetails({ contextWindow: 32_000 }, CATALOGUE);
    expect(fill.sources).toEqual(["pricing", "toolSupport", "reasoning"]);
    expect(fill.sources).not.toContain("contextWindow");
  });

  it("keeps a filled value badged on a later visit, when nothing new is filled", () => {
    // The second visit finds every field already set, so it fills nothing — but
    // the price still came from the catalogue and must stay marked as such.
    const second = fillMissingDetails(
      { contextWindow: 200_000, pricing: CATALOGUE.pricing, toolSupport: true, reasoning: true },
      CATALOGUE,
      ["pricing", "toolSupport", "reasoning"],
    );
    expect(second.autoFilled).toEqual([]);
    expect(second.sources).toEqual(["pricing", "toolSupport", "reasoning"]);
  });

  it("drops the mark once the user sets that field themselves", () => {
    // `contextWindow` was catalogue-sourced, then the user typed 32k. The value
    // looks identical to the fill's own, so only the write path can tell; it
    // clears the mark for the fields the user touched.
    expect(sourcesAfterUserEdit(["contextWindow", "pricing"], ["contextWindow"])).toEqual(["pricing"]);
    expect(sourcesAfterUserEdit(["contextWindow"], [])).toEqual(["contextWindow"]);
    expect(sourcesAfterUserEdit(null, ["pricing"])).toEqual([]);
  });

  it("drops the mark for a field that has since been cleared", () => {
    const fill = fillMissingDetails({ contextWindow: null }, null, ["contextWindow"]);
    expect(fill.sources).toEqual([]);
  });
});
