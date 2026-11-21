import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { SHAPES, DEFAULT_SHAPE, isShapeId, shapeById, shapeDefinition, renderAvatarSvg, resolveColor } from "../src/index.ts";

/** Gallery ids alphabetical, then the package's own examples in package order. */
const CONTRACT_ORDER = [
  "book",
  "brain",
  "bull",
  "bunny",
  "camera",
  "cat",
  "cloud",
  "egg",
  "ghost",
  "magnifier",
  "paint-brush",
  "palette",
  "rocket",
  "shield",
  "star",
  "witch-hat",
  "controller",
  "barbell",
  "mug",
  "lightbulb",
  "chat",
  "sprout",
  "watering-can",
] as const;

/** Ids from the families this registry replaced; none of them may still resolve. */
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
  "circle",
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

describe("open-bot-avatar's avatar set", () => {
  it("lists all 23 ids exactly once, gallery then examples", () => {
    expect(SHAPES.map((shape) => shape.id)).toEqual([...CONTRACT_ORDER]);
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(CONTRACT_ORDER.length);
  });

  it("keeps the lookup helpers consistent with the list", () => {
    expect(DEFAULT_SHAPE).toBe("book");
    for (const id of CONTRACT_ORDER) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id).definition).toBe(shapeDefinition(id));
      expect(shapeDefinition(id).id).toBe(id);
    }
    expect(isShapeId("bean")).toBe(false);
    expect(shapeById("bean").id).toBe("book");
  });

  it.each(RETIRED)("falls back to the first id for the retired id %s", (id) => {
    expect(isShapeId(id)).toBe(false);
    expect(shapeById(id).id).toBe(DEFAULT_SHAPE);
    expect(shapeDefinition(id)).toBe(shapeDefinition(DEFAULT_SHAPE));
    expect(renderAvatarSvg({ shape: id, color: "sky", size: 64 })).toBe(
      renderAvatarSvg({ shape: DEFAULT_SHAPE, color: "sky", size: 64 }),
    );
  });

  it.each(CONTRACT_ORDER)("%s passes open-bot-avatar validation", (id) => {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it.each(CONTRACT_ORDER)("%s keeps the definition's own eyes and a closed path", (id) => {
    const definition = shapeDefinition(id);
    expect(definition.body.path.startsWith("M")).toBe(true);
    expect(definition.body.path.trimEnd().endsWith("Z")).toBe(true);
    expect(definition.eyes.x).toBeGreaterThan(6);
    expect(definition.eyes.x).toBeLessThan(94);
    expect(definition.eyes.y).toBeGreaterThan(6);
    expect(definition.eyes.y).toBeLessThan(94);
    expect(definition.eyes.scale).toBeLessThanOrEqual(1.8);
  });

  it("renders deterministically and paints the silhouette in the requested colour", () => {
    for (const id of CONTRACT_ORDER) {
      const first = renderAvatarSvg({ shape: id, color: "tomato", size: 48 });
      expect(renderAvatarSvg({ shape: id, color: "tomato", size: 48 })).toBe(first);
      expect(first.toLowerCase()).toContain(resolveColor("tomato"));
    }
  });

  it("leaves eye colour and depth to the package", () => {
    const svg = renderAvatarSvg({ shape: "controller", color: "ember", size: 96 });
    expect(svg).toContain('fill="#151515"');
    expect(svg).not.toContain("fill-opacity");
  });
});
