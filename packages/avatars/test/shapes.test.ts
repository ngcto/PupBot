import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { SHAPES, DEFAULT_SHAPE, isShapeId, shapeById, shapeDefinition, renderAvatarSvg, resolveColor } from "../src/index.ts";

const CONTRACT_ORDER = [
  "circle",
  "cloud",
  "square",
  "star4",
  "quatrefoil",
  "heart",
  "flower",
  "drop",
  "pill",
  "pick",
  "house",
  "splat",
  "hexagon",
] as const;

/** Ids from the families this set replaced; none of them may still resolve. */
const RETIRED = [
  "orb",
  "squircle",
  "bell",
  "arch",
  "hexa",
  "gem",
  "crest",
  "horns",
  "antennae",
  "scallop",
  "shoulder",
] as const;

describe("traced shapes", () => {
  it("lists every contract id exactly once, in contract order", () => {
    expect(SHAPES.map((shape) => shape.id)).toEqual([...CONTRACT_ORDER]);
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(CONTRACT_ORDER.length);
  });

  it("keeps the lookup helpers consistent with the list", () => {
    expect(DEFAULT_SHAPE).toBe("circle");
    for (const id of CONTRACT_ORDER) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id).definition).toBe(shapeDefinition(id));
      expect(shapeDefinition(id).id).toBe(id);
    }
    expect(isShapeId("bean")).toBe(false);
    expect(shapeById("bean").id).toBe("circle");
  });

  it.each(RETIRED)("falls back to circle for the retired id %s", (id) => {
    expect(isShapeId(id)).toBe(false);
    expect(shapeById(id).id).toBe("circle");
    expect(shapeDefinition(id)).toBe(shapeDefinition("circle"));
    expect(renderAvatarSvg({ shape: id, color: "sky", size: 64 })).toBe(
      renderAvatarSvg({ shape: "circle", color: "sky", size: 64 }),
    );
  });

  it.each(CONTRACT_ORDER)("%s passes open-bot-avatar validation", (id) => {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it.each(CONTRACT_ORDER)("%s is one closed filled path with a level, centred eye pair", (id) => {
    const { body, eyes } = shapeDefinition(id);
    expect(body.path.startsWith("M")).toBe(true);
    expect(body.path.trimEnd().endsWith("Z")).toBe(true);
    expect(body.path).not.toMatch(/[Aa]/);
    expect(eyes.x).toBe(50);
    expect(eyes.spacing).toBeGreaterThan(12);
    expect(eyes.spacing).toBeLessThan(22);
    expect(eyes.scale).toBeLessThanOrEqual(1.8);
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

  it("gives the eyes the contract ink at 90% opacity", () => {
    const svg = renderAvatarSvg({ shape: "circle", color: "sky", size: 96 });
    expect(svg).toContain('fill="#121212" fill-opacity="0.9"');
  });
});
