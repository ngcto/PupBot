import { describe, expect, it } from "vitest";
import { COLORS, colorHex, deriveAccent, parseHex, renderAvatarSvg, resolveColor } from "../src/index.ts";

const PALETTE = {
  chalk: "#ffffff",
  sand: "#a16b39",
  tomato: "#fc2c3e",
  ember: "#f9670e",
  amber: "#f69412",
  leaf: "#14c370",
  teal: "#13b8a3",
  sky: "#1884fc",
  iris: "#905afb",
  bloom: "#fb3499",
  slate: "#777777",
} as const;

describe("palette", () => {
  it("has the eleven contract colours in order", () => {
    expect(COLORS.map((color) => color.id)).toEqual(Object.keys(PALETTE));
  });

  it.each(Object.entries(PALETTE))("%s resolves to %s", (id, hex) => {
    expect(colorHex(id as keyof typeof PALETTE)).toBe(hex);
    expect(resolveColor(id)).toBe(hex);
  });

  it("passes unknown strings through as CSS colours", () => {
    expect(resolveColor("#123456")).toBe("#123456");
  });
});

describe("deriveAccent", () => {
  const measured: Array<[string, string, number]> = [
    ["#f69412", "#c8780e", 6],
    ["#1884fc", "#136ed2", 6],
    ["#fc2c3e", "#cf2b35", 7],
    ["#ffffff", "#3b3b3b", 6],
  ];

  it.each(measured)("%s derives %s within %i of 255 per channel", (input, expected, tolerance) => {
    const got = parseHex(deriveAccent(input));
    const want = parseHex(expected);
    expect(got).not.toBeNull();
    expect(want).not.toBeNull();
    got?.forEach((channel, i) => {
      expect(Math.abs(channel - (want?.[i] ?? 0))).toBeLessThanOrEqual(tolerance);
    });
  });

  it("returns an unparseable colour unchanged", () => {
    expect(deriveAccent("var(--brand)")).toBe("var(--brand)");
  });
});

describe("renderAvatarSvg", () => {
  it("is identical across two calls for the same input", () => {
    const first = renderAvatarSvg({ shape: "circle", color: "amber", size: 64 });
    expect(renderAvatarSvg({ shape: "circle", color: "amber", size: 64 })).toBe(first);
  });

  it("fills the head with the palette hex", () => {
    expect(renderAvatarSvg({ shape: "circle", color: "amber", size: 64 }).toLowerCase()).toContain("#f69412");
  });


});
