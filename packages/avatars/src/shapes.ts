import type { AvatarDefinition, AvatarShape, AvatarShapeId, EyeSlot, Shape } from "./types.ts";

/**
 * Canonical PupBot avatar contract from `handoffs/spec/avatars.json`.
 * Thirteen soft, mirror-symmetric silhouettes in stable order. One readable
 * form per head, generous radii, nothing thinner than 0.08 of the box, and
 * corners no tighter than 0.1. Eyes are identical vertical rounded slots.
 */

const BOX = 100;
const CENTRE = 50;
const WIDE = 88; // 0.88 of box at widest
const COG_REACH = 96; // gear cogs may reach 0.96

const EYE_W = BOX * 0.22;
const EYE_H = BOX * 0.34;
const GAP = BOX * 0.18;

function circle(cx: number, cy: number, r: number): Shape {
  return { kind: "circle", cx, cy, r };
}
function ellipse(cx: number, cy: number, rx: number, ry: number): Shape {
  return { kind: "ellipse", cx, cy, rx, ry };
}
function roundedRect(x: number, y: number, w: number, h: number, r: number): Shape {
  return { kind: "rect", x, y, w, h, r };
}
function roundedPolygon(points: Array<[number, number]>, cornerRadius = 0): Shape {
  return { kind: "polygon", points, cornerRadius };
}

function eyeSlots(y: number): [EyeSlot, EyeSlot] {
  const top = BOX * y - EYE_H / 2;
  const leftX = CENTRE - GAP / 2 - EYE_W;
  const rightX = CENTRE + GAP / 2;
  return [
    { x: leftX, y: top, w: EYE_W, h: EYE_H },
    { x: rightX, y: top, w: EYE_W, h: EYE_H },
  ];
}

function hexPoints(cx: number, cy: number, rx: number, ry: number): Array<[number, number]> {
  // Flat-topped hexagon.
  return [0, 60, 120, 180, 240, 300].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

function superellipsePoints(
  cx: number,
  cy: number,
  a: number,
  b: number,
  n = 4.8,
  steps = 64,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = Math.sign(cos) * Math.pow(Math.abs(cos), 2 / n);
    const y = Math.sign(sin) * Math.pow(Math.abs(sin), 2 / n);
    pts.push([cx + a * x, cy + b * y]);
  }
  return pts;
}

const SHAPE_DEFS: AvatarShape[] = [
  {
    id: "circle",
    name: "Circle",
    note: "Perfect circle, the plainest head",
    eyeY: 0.46,
    parts: [circle(CENTRE, CENTRE, WIDE / 2)],
  },
  {
    id: "squircle",
    name: "Squircle",
    note: "Superellipse (Apple-icon)",
    eyeY: 0.46,
    parts: [roundedPolygon(superellipsePoints(CENTRE, CENTRE, WIDE / 2, WIDE / 2, 4.8, 72), 0)],
  },
  {
    id: "drop",
    name: "Drop",
    note: "Circle base rising to a soft top point",
    eyeY: 0.56,
    parts: [
      roundedPolygon(
        [
          [CENTRE, 8],
          [62, 15],
          [74, 28],
          [83, 46],
          [84, 62],
          [74, 78],
          [CENTRE, 92],
          [26, 78],
          [16, 62],
          [17, 46],
          [26, 28],
          [38, 15],
        ],
        20,
      ),
    ],
  },
  {
    id: "cloud",
    name: "Cloud",
    note: "Three equal soft lobes on a flat-ish base",
    eyeY: 0.48,
    parts: [
      circle(30, 44, 18),
      circle(CENTRE, 36, 20),
      circle(70, 44, 18),
      roundedRect(14, 46, 72, 34, 17),
    ],
  },
  {
    id: "hexa",
    name: "Hexa",
    note: "Rounded hexagon, flat top and bottom",
    eyeY: 0.46,
    parts: [roundedPolygon(hexPoints(CENTRE, CENTRE, 46, 43), 14)],
  },
  {
    id: "gear",
    name: "Gear",
    note: "Circle with 6 soft rounded cogs, cogs reach 0.96",
    eyeY: 0.46,
    parts: (() => {
      const coreR = 33;
      const cogR = 11;
      const orbit = COG_REACH - cogR; // 85, cog outer edge reaches 96
      const cogs = Array.from({ length: 6 }, (_, i) => {
        const a = ((-90 + i * 60) * Math.PI) / 180;
        return circle(CENTRE + Math.cos(a) * orbit, CENTRE + Math.sin(a) * orbit, cogR);
      });
      return [circle(CENTRE, CENTRE, coreR), ...cogs];
    })(),
  },
  {
    id: "oval",
    name: "Oval",
    note: "Tall ellipse",
    eyeY: 0.42,
    parts: [ellipse(CENTRE, CENTRE, 34, 44)],
  },
  {
    id: "triangle",
    name: "Triangle",
    note: "Upward rounded triangle",
    eyeY: 0.56,
    parts: [
      roundedPolygon(
        [
          [CENTRE, 10],
          [90, 88],
          [10, 88],
        ],
        22,
      ),
    ],
  },
  {
    id: "shield",
    name: "Shield",
    note: "Flat top, sides curving to a base point",
    eyeY: 0.42,
    parts: [
      roundedPolygon(
        [
          [14, 10],
          [86, 10],
          [86, 46],
          [74, 72],
          [CENTRE, 92],
          [26, 72],
          [14, 46],
        ],
        14,
      ),
    ],
  },
  {
    id: "puff",
    name: "Puff",
    note: "Soft four-lobed clover",
    eyeY: 0.46,
    parts: [
      circle(CENTRE, 26, 20),
      circle(74, CENTRE, 20),
      circle(CENTRE, 74, 20),
      circle(26, CENTRE, 20),
      circle(CENTRE, CENTRE, 18),
    ],
  },
  {
    id: "pill",
    name: "Pill",
    note: "Tall stadium (full capsule)",
    eyeY: 0.46,
    parts: [roundedRect(16, 6, 68, 88, 34)],
  },
  {
    id: "diamond",
    name: "Diamond",
    note: "Rounded diamond, point up and down",
    eyeY: 0.46,
    parts: [
      roundedPolygon(
        [
          [CENTRE, 6],
          [88, CENTRE],
          [CENTRE, 94],
          [12, CENTRE],
        ],
        18,
      ),
    ],
  },
  {
    id: "arch",
    name: "Arch",
    note: "Semicircle top on straight-ish sides to a flat base",
    eyeY: 0.42,
    parts: [
      roundedPolygon(
        [
          [14, 92],
          [14, 44],
          [20, 26],
          [34, 12],
          [CENTRE, 8],
          [66, 12],
          [80, 26],
          [86, 44],
          [86, 92],
        ],
        12,
      ),
    ],
  },
];

export const SHAPES: readonly AvatarShape[] = SHAPE_DEFS;
export const AVATAR_SHAPES = SHAPES;

export const SHAPE_IDS = SHAPES.map((shape) => shape.id) as readonly AvatarShapeId[];

const byId = new Map<AvatarShapeId, AvatarShape>(SHAPE_DEFS.map((shape) => [shape.id, shape]));

// Legacy out-of-spec ids kept readable by mapping to the closest canonical shape.
const LEGACY_TO_CANONICAL: Record<string, AvatarShapeId> = {
  orb: "circle",
  bell: "arch",
  gem: "diamond",
  crest: "puff",
  horns: "triangle",
  antennae: "gear",
  scallop: "cloud",
  shoulder: "shield",
};

function resolveId(id: string): AvatarShapeId | undefined {
  if (byId.has(id as AvatarShapeId)) return id as AvatarShapeId;
  return LEGACY_TO_CANONICAL[id];
}

export function isShapeId(id: string): id is AvatarShapeId {
  return resolveId(id) !== undefined;
}

export function shapeById(id: AvatarShapeId | string): AvatarShape | undefined {
  const resolved = resolveId(id);
  return resolved ? byId.get(resolved) : undefined;
}

/** Full definition with two identical rounded-slot eyes placed per shape. */
export function shapeDefinition(id: AvatarShapeId | string): AvatarDefinition | undefined {
  const shape = shapeById(id);
  if (!shape) return undefined;
  return { ...shape, eyes: eyeSlots(shape.eyeY) };
}
