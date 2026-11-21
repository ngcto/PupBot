import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { SHAPES, DEFAULT_SHAPE, EYE_FIT, eyeCapsules, isShapeId, shapeById, shapeDefinition, renderAvatarSvg, resolveColor } from "../src/index.ts";

const CONTRACT_ORDER = [
  "mug",
  "lightbulb",
  "chat",
  "sprout",
  "watering-can",
  "bull",
  "bunny",
  "camera",
  "cat",
  "cloud",
  "ghost",
  "rocket",
  "star",
  "witch-hat",
] as const;

/** Ids this registry retired or never shipped; none of them may still resolve. */
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
  "star4",
  "quatrefoil",
  "flower",
  "drop",
  "pill",
  "pick",
  "house",
  "splat",
  "hexagon",
  "book",
  "brain",
  "egg",
  "magnifier",
  "paint-brush",
  "palette",
  "shield",
  "controller",
  "barbell",
  "circle",
  "square",
  "water-drop",
  "heart",
] as const;

describe("avatar registry", () => {
  it("lists all 14 ids exactly once, in contract order", () => {
    expect(SHAPES.map((shape) => shape.id)).toEqual([...CONTRACT_ORDER]);
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(CONTRACT_ORDER.length);
  });

  it("keeps the lookup helpers consistent with the list", () => {
    expect(DEFAULT_SHAPE).toBe("mug");
    for (const id of CONTRACT_ORDER) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id).definition).toBe(shapeDefinition(id));
      expect(shapeDefinition(id).id).toBe(id);
    }
    expect(isShapeId("bean")).toBe(false);
    expect(shapeById("bean").id).toBe("mug");
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

  it("turns no glyph as a whole: the lean lives in the eyes", () => {
    for (const id of CONTRACT_ORDER) {
      const svg = renderAvatarSvg({ shape: id, color: "sky", size: 64 });
      expect(svg, id).not.toContain("rotate(12 50 50)");
      expect(svg, id).not.toContain("rotate(-12 50 50)");
      expect(svg, id).not.toContain("rotate(0 50 50)");
    }
  });

  it.each(CONTRACT_ORDER)("%s draws its own eye pair and leaves the package's out", (id) => {
    const svg = renderAvatarSvg({ shape: id, color: "sky", size: 64 });
    const ink = svg.match(/fill="#151515"/g) ?? [];
    expect(ink).toHaveLength(2);
    expect((svg.match(/<rect[^>]*fill="#151515"/g) ?? [])).toHaveLength(2);
  });

  it("builds the eye pair the reference draws: a fat low near eye, a thin high far eye, both slanted", () => {
    for (const id of CONTRACT_ORDER) {
      const [near, far] = eyeCapsules(shapeDefinition(id) as never);
      expect(near.width, id).toBeGreaterThan(far.width * 1.2);
      expect(near.width / far.width, id).toBeLessThan(1.45);
      expect(near.length / near.width, id).toBeGreaterThan(1.8);
      expect(far.length / far.width, id).toBeGreaterThan(2.2);
      expect(near.cx, id).toBeLessThan(far.cx);
      expect(near.cy, id).toBeGreaterThan(far.cy);
      for (const capsule of [near, far]) {
        expect(capsule.angle).toBeGreaterThan(58);
        expect(capsule.angle).toBeLessThan(62);
      }
    }
  });

  it("keeps the fit table to glyphs that need it", () => {
    expect(Object.keys(EYE_FIT).sort()).toEqual(["rocket", "witch-hat"]);
  });

  it("leaves eye colour and depth to the package", () => {
    const svg = renderAvatarSvg({ shape: "mug", color: "ember", size: 96 });
    expect(svg).toContain('fill="#151515"');
    expect(svg).not.toContain("fill-opacity");
  });
});
