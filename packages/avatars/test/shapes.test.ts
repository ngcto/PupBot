import { describe, expect, it } from "vitest";
import {
  AVATAR_SHAPES,
  SHAPE_IDS,
  SHAPES,
  isShapeId,
  renderAvatarSvg,
  resolveColor,
  shapeById,
  shapeDefinition,
} from "../src/index.ts";

describe("shape registry", () => {
  it("covers the canonical thirteen soft shapes in stable order", () => {
    expect(SHAPES).toHaveLength(13);
    expect(AVATAR_SHAPES).toBe(SHAPES);
    expect([...SHAPE_IDS]).toEqual([
      "circle",
      "squircle",
      "drop",
      "cloud",
      "hexa",
      "gear",
      "oval",
      "triangle",
      "shield",
      "puff",
      "pill",
      "diamond",
      "arch",
    ]);
  });

  it("does not define a PupBot-owned avatar default export", async () => {
    const mod = await import("../src/index.ts");
    expect("DEFAULT_SHAPE" in mod).toBe(false);
    expect("defaultAvatar" in mod).toBe(false);
  });

  it("resolves canonical ids and rejects unknown ones", () => {
    for (const id of SHAPE_IDS) {
      expect(isShapeId(id)).toBe(true);
      expect(shapeById(id)?.id).toBe(id);
      expect(shapeDefinition(id)).toBeDefined();
    }
    expect(isShapeId("banana")).toBe(false);
    expect(shapeById("banana")).toBeUndefined();
  });

  it("keeps legacy out-of-spec ids readable for compatibility", () => {
    expect(isShapeId("orb")).toBe(true);
    expect(shapeById("orb")?.id).toBe("circle");
    expect(shapeById("bell")?.id).toBe("arch");
    expect(shapeDefinition("scallop")?.id).toBe("cloud");
  });
});

describe("silhouette and eye contract", () => {
  it("keeps every silhouette part within the 0..100 box", () => {
    for (const shape of SHAPES) {
      const def = shapeDefinition(shape.id)!;
      expect(def.parts.length, shape.id).toBeGreaterThan(0);
      for (const part of def.parts) {
        if (part.kind === "circle") {
          expect(part.cx - part.r).toBeGreaterThanOrEqual(-0.01);
          expect(part.cy - part.r).toBeGreaterThanOrEqual(-0.01);
          expect(part.cx + part.r).toBeLessThanOrEqual(100.01);
          expect(part.cy + part.r).toBeLessThanOrEqual(100.01);
        } else if (part.kind === "ellipse") {
          expect(part.cx - part.rx).toBeGreaterThanOrEqual(-0.01);
          expect(part.cy - part.ry).toBeGreaterThanOrEqual(-0.01);
          expect(part.cx + part.rx).toBeLessThanOrEqual(100.01);
          expect(part.cy + part.ry).toBeLessThanOrEqual(100.01);
        } else if (part.kind === "rect") {
          expect(part.x).toBeGreaterThanOrEqual(-0.01);
          expect(part.y).toBeGreaterThanOrEqual(-0.01);
          expect(part.x + part.w).toBeLessThanOrEqual(100.01);
          expect(part.y + part.h).toBeLessThanOrEqual(100.01);
        } else {
          const xs = part.points.map(([x]) => x);
          const ys = part.points.map(([, y]) => y);
          expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.01);
          expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.01);
          expect(Math.max(...xs)).toBeLessThanOrEqual(100.01);
          expect(Math.max(...ys)).toBeLessThanOrEqual(100.01);
        }
      }
    }
  });

  it("uses simple contract eyes with the specified per-shape placement", () => {
    const w = 22;
    const h = 34;
    const gap = 18;
    const expectedY: Record<string, number> = {
      circle: 0.46,
      squircle: 0.46,
      hexa: 0.46,
      gear: 0.46,
      puff: 0.46,
      pill: 0.46,
      diamond: 0.46,
      cloud: 0.48,
      oval: 0.42,
      shield: 0.42,
      arch: 0.42,
      drop: 0.56,
      triangle: 0.56,
    };

    for (const shape of SHAPES) {
      expect(shape.eyeY).toBe(expectedY[shape.id]);
      const def = shapeDefinition(shape.id)!;
      expect(def.eyes).toHaveLength(2);
      const [left, right] = def.eyes;
      expect(left.w).toBeCloseTo(w, 5);
      expect(right.w).toBeCloseTo(w, 5);
      expect(left.h).toBeCloseTo(h, 5);
      expect(right.h).toBeCloseTo(h, 5);
      expect(left.y).toBeCloseTo(expectedY[shape.id] * 100 - h / 2, 5);
      expect(right.y).toBeCloseTo(left.y, 5);
      const leftCentre = left.x + left.w / 2;
      const rightCentre = right.x + right.w / 2;
      expect((leftCentre + rightCentre) / 2).toBeCloseTo(50, 4);
      expect(rightCentre - leftCentre).toBeCloseTo(w + gap, 4);
    }
  });

  it("keeps silhouettes mirror-symmetric about the vertical centre", () => {
    for (const shape of SHAPES) {
      const def = shapeDefinition(shape.id)!;
      const xs = def.parts.flatMap((part) => {
        if (part.kind === "circle") return [part.cx - part.r, part.cx, part.cx + part.r];
        if (part.kind === "ellipse") return [part.cx - part.rx, part.cx, part.cx + part.rx];
        if (part.kind === "rect") return [part.x, part.x + part.w / 2, part.x + part.w];
        return part.points.map(([x]) => x);
      });
      const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(Math.abs(centre - 50), shape.id).toBeLessThan(2);
    }
  });
});

describe("renderer", () => {
  it("renders the silhouette at the requested colour and size", () => {
    const svg = renderAvatarSvg({ shape: "circle", color: "white", size: 96 });
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('width="96"');
    expect(svg).toContain(`fill="${resolveColor("white")}"`);
  });

  it("accepts palette ids and raw CSS colours", () => {
    expect(renderAvatarSvg({ shape: "circle", color: "teal", size: 32 })).toContain(
      'fill="#1aa7a9"',
    );
    expect(renderAvatarSvg({ shape: "circle", color: "rgb(1, 2, 3)", size: 32 })).toContain(
      'fill="rgb(1, 2, 3)"',
    );
  });

  it("renders every canonical shape without throwing", () => {
    for (const shape of SHAPES) {
      const svg = renderAvatarSvg({ shape: shape.id, color: "blue", size: 32 });
      expect(svg).toContain("<svg");
      expect(svg.length).toBeGreaterThan(80);
    }
  });

  it("draws simple slot eyes (no pupil/highlight) in contract ink", () => {
    const svg = renderAvatarSvg({ shape: "circle", color: "white", size: 96 });
    expect(svg).toContain('class="eye-slot"');
    expect(svg).toContain('fill="#121212"');
    expect(svg).toContain('fill-opacity="0.9"');
    expect(svg).not.toMatch(/pupil/i);
  });

  it("keeps the SVG accessible", () => {
    const labelled = renderAvatarSvg({ shape: "circle", color: "white", size: 32, title: "Bot" });
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain("<title>Bot</title>");

    const decorative = renderAvatarSvg({ shape: "circle", color: "white", size: 32, title: "" });
    expect(decorative).toContain('aria-hidden="true"');
  });
});
