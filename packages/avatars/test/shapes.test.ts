import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { SHAPES, DEFAULT_SHAPE, isShapeId, shapeById, shapeDefinition, renderAvatarSvg, resolveColor } from "../src/index.ts";

const CONTRACT_ORDER = [
  "pup",
  "fold",
  "point",
  "flop",
  "tuft",
  "snout",
  "pug",
  "dane",
  "bun",
  "shag",
  "squish",
  "vulpine",
  "crown",
] as const;

describe("dog-head shapes", () => {
  it("lists every contract id exactly once, in contract order", () => {
    expect(SHAPES.map((shape) => shape.id)).toEqual([...CONTRACT_ORDER]);
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(CONTRACT_ORDER.length);
  });

  it("keeps the lookup helpers consistent with the list", () => {
    expect(DEFAULT_SHAPE).toBe("pup");
    for (const id of CONTRACT_ORDER) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id).definition).toBe(shapeDefinition(id));
      expect(shapeDefinition(id).id).toBe(id);
    }
    expect(isShapeId("bean")).toBe(false);
    expect(() => shapeById("bean" as never)).toThrow();
  });

  it.each(CONTRACT_ORDER)("%s passes open-bot-avatar validation", (id) => {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it.each(CONTRACT_ORDER)("%s keeps every path coordinate inside the 8..92 safe area", (id) => {
    const numbers = (shapeDefinition(id).body.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(8);
      expect(value).toBeLessThanOrEqual(92);
    }
  });

  it.each(CONTRACT_ORDER)("%s is one closed filled path with eyes inside the safe area", (id) => {
    const { body, eyes } = shapeDefinition(id);
    expect(body.path).toMatch(/^M [^MZ]+ Z$/);
    expect(eyes.x - eyes.spacing / 2).toBeGreaterThan(8);
    expect(eyes.x + eyes.spacing / 2).toBeLessThan(92);
    expect(eyes.y).toBeGreaterThan(8);
    expect(eyes.y).toBeLessThan(92);
  });

  it("renders deterministically and paints the silhouette in the requested colour", () => {
    for (const id of CONTRACT_ORDER) {
      const first = renderAvatarSvg({ shape: id, color: "tomato", size: 48 });
      expect(renderAvatarSvg({ shape: id, color: "tomato", size: 48 })).toBe(first);
      expect(first.toLowerCase()).toContain(resolveColor("tomato"));
    }
  });

  it("gives the eyes the contract ink at 90% opacity", () => {
    const svg = renderAvatarSvg({ shape: "pup", color: "sky", size: 96 });
    expect(svg).toContain('fill="#121212" fill-opacity="0.9"');
  });
});
