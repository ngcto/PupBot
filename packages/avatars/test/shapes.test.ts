import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { SHAPES, DEFAULT_SHAPE, isShapeId, shapeById, shapeDefinition, renderAvatarSvg, resolveColor } from "../src/index.ts";

function coordinatesOf(path: string): Array<[number, number]> {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: Array<[number, number]> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push([numbers[index]!, numbers[index + 1]!]);
  }
  return points;
}

const CONTRACT_ORDER = [
  "orb",
  "squircle",
  "drop",
  "bell",
  "arch",
  "hexa",
  "pill",
  "gem",
  "crest",
  "horns",
  "antennae",
  "scallop",
  "shoulder",
] as const;

describe("symmetric shapes", () => {
  it("lists every contract id exactly once, in contract order", () => {
    expect(SHAPES.map((shape) => shape.id)).toEqual([...CONTRACT_ORDER]);
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(CONTRACT_ORDER.length);
  });

  it("keeps the lookup helpers consistent with the list", () => {
    expect(DEFAULT_SHAPE).toBe("orb");
    for (const id of CONTRACT_ORDER) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id).definition).toBe(shapeDefinition(id));
      expect(shapeDefinition(id).id).toBe(id);
    }
    expect(isShapeId("bean")).toBe(false);
    expect(shapeById("bean").id).toBe("orb");
  });

  it.each(CONTRACT_ORDER)("%s passes open-bot-avatar validation", (id) => {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it.each(CONTRACT_ORDER)("%s keeps every path coordinate inside the 6..94 safe area", (id) => {
    const numbers = (shapeDefinition(id).body.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(6);
      expect(value).toBeLessThanOrEqual(94);
    }
  });

  it.each(CONTRACT_ORDER)("%s is one closed filled path with eyes inside the safe area", (id) => {
    const { body, eyes } = shapeDefinition(id);
    expect(body.path.startsWith("M ")).toBe(true);
    expect(body.path.trimEnd().endsWith("Z")).toBe(true);
    expect(body.path).not.toMatch(/[Aa]/);
    expect(eyes.x - eyes.spacing / 2).toBeGreaterThan(6);
    expect(eyes.x + eyes.spacing / 2).toBeLessThan(94);
    expect(eyes.y).toBeGreaterThan(6);
    expect(eyes.y).toBeLessThan(94);
  });

  it("renders deterministically and paints the silhouette in the requested colour", () => {
    for (const id of CONTRACT_ORDER) {
      const first = renderAvatarSvg({ shape: id, color: "tomato", size: 48 });
      expect(renderAvatarSvg({ shape: id, color: "tomato", size: 48 })).toBe(first);
      expect(first.toLowerCase()).toContain(resolveColor("tomato"));
    }
  });

  it.each(CONTRACT_ORDER)("%s mirrors exactly about the vertical axis", (id) => {
    const points = coordinatesOf(shapeDefinition(id).body.path);
    const tolerance = 0.35;
    for (const [x, y] of points) {
      const mirrored = points.some(
        ([ox, oy]) => Math.abs(ox - (100 - x)) <= tolerance && Math.abs(oy - y) <= tolerance,
      );
      expect(mirrored, `no mirror for (${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
    }
  });

  it.each(CONTRACT_ORDER)("%s stays centred on x = 50", (id) => {
    const points = coordinatesOf(shapeDefinition(id).body.path);
    const xs = points.map(([x]) => x);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(100, 1);
  });

  it("gives the eyes the contract ink at 90% opacity", () => {
    const svg = renderAvatarSvg({ shape: "orb", color: "sky", size: 96 });
    expect(svg).toContain('fill="#121212" fill-opacity="0.9"');
  });
});
