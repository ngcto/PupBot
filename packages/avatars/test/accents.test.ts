import { describe, expect, it } from "vitest";
import { COLORS, bubbleHex, colorById, colorHex, deriveAccent, isColorId, parseHex, resolveColor } from "../src/index.ts";

const SPEC: Record<string, { hex: string; bubble: string }> = {
  white: { hex: "#ffffff", bubble: "#cfcfcf" },
  brown: { hex: "#a16b39", bubble: "#865b32" },
  red: { hex: "#fc2c3e", bubble: "#cf2b35" },
  orange: { hex: "#f9670e", bubble: "#ce570e" },
  yellow: { hex: "#f69412", bubble: "#c8780e" },
  green: { hex: "#16a04f", bubble: "#14843f" },
  aqua: { hex: "#0daabd", bubble: "#0d8c99" },
  teal: { hex: "#1aa7a9", bubble: "#178a8a" },
  blue: { hex: "#1884fc", bubble: "#136ed2" },
  purple: { hex: "#5c6cf9", bubble: "#4b59d8" },
  pink: { hex: "#fa6b92", bubble: "#d65979" },
  grey: { hex: "#7a7a7a", bubble: "#676767" },
  black: { hex: "#333333", bubble: "#303030" },
};

describe("colour palette", () => {
  it("exposes the canonical thirteen colours in order", () => {
    expect(COLORS).toHaveLength(13);
    expect(COLORS.map((c) => c.id)).toEqual([
      "white",
      "brown",
      "red",
      "orange",
      "yellow",
      "green",
      "aqua",
      "teal",
      "blue",
      "purple",
      "pink",
      "grey",
      "black",
    ]);
  });

  it("matches the canonical hex and bubble values", () => {
    for (const color of COLORS) {
      const spec = SPEC[color.id];
      expect(spec, color.id).toBeDefined();
      expect(color.hex).toBe(spec.hex);
      expect(color.bubble).toBe(spec.bubble);
      expect(isColorId(color.id)).toBe(true);
      expect(colorById(color.id)).toEqual(color);
      expect(colorHex(color.id)).toBe(color.hex);
      expect(resolveColor(color.id)).toBe(color.hex);
      expect(bubbleHex(color.id)).toBe(color.bubble);
    }
  });

  it("passes unknown or raw colours through resolveColor", () => {
    expect(resolveColor("rebeccapurple")).toBe("rebeccapurple");
  });
});

describe("accent derivation", () => {
  it("returns canonical bubble accents for palette ids", () => {
    for (const color of COLORS) {
      expect(deriveAccent(color.id)).toBe(color.bubble);
      expect(deriveAccent(color.hex)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps already-dark custom colours readable (no brightening)", () => {
    const dark = "#102030";
    const accent = deriveAccent(dark);
    const src = parseHex(dark)!;
    const out = parseHex(accent)!;
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(lum(out)).toBeLessThanOrEqual(lum(src) + 1);
  });

  it("passes through non-hex strings unchanged", () => {
    expect(deriveAccent("rgb(10,20,30)")).toBe("rgb(10,20,30)");
  });
});
