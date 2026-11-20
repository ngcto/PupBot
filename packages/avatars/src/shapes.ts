import type { AvatarDefinition, AvatarShape } from "./types.ts";

/**
 * Symmetric silhouettes only: every outline mirrors exactly about x = 50.
 * Vertical asymmetry is used on purpose (crests, horns, antennae, scallops,
 * flat bases, wide shoulders); horizontal asymmetry is never allowed. Eyes may
 * sit off-centre vertically; the outline may not sit off-centre horizontally.
 *
 * The ids and their proportions come from `handoffs/spec/avatars.json`. Adding
 * or renaming a shape is one entry in DRAFTS.
 */
const CENTRE = 50;
/** The renderer refuses geometry outside 6..94, so a silhouette fills 0.88. */
const SAFE_MIN = 6;
const SAFE_MAX = 94;
const SPAN = SAFE_MAX - SAFE_MIN;
const STEPS = 96;

type Pt = [number, number];

/** x = 50 ± rx·|cos|^(2/n), y = cy ± ry·|sin|^(2/n): symmetric by construction. */
function superellipse(cy: number, rx: number, ry: number, top = 2, bottom = 2): string {
  const points: string[] = [];
  for (let index = 0; index < STEPS; index += 1) {
    const angle = (index / STEPS) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const exponent = sin < 0 ? top : bottom;
    const x = CENTRE + rx * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = cy + ry * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push(fmt([x, y]));
  }
  return `M ${points.join(" L ")} Z`;
}

function circle(cx: number, cy: number, radius: number): string {
  const points: string[] = [];
  for (let index = 0; index < STEPS; index += 1) {
    const angle = (index / STEPS) * Math.PI * 2;
    points.push(fmt([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]));
  }
  return `M ${points.join(" L ")} Z`;
}

/** A vertical capsule: two half circles joined by straight sides. */
function capsule(cy: number, width: number, height: number): string {
  const rx = width / 2;
  const ry = height / 2;
  const top = cy - ry;
  const bottom = cy + ry;
  const left = CENTRE - rx;
  const right = CENTRE + rx;
  return [
    `M ${left} ${top + rx}`,
    `Q ${left} ${top} ${left + rx} ${top}`,
    `L ${right - rx} ${top}`,
    `Q ${right} ${top} ${right} ${top + rx}`,
    `L ${right} ${bottom - rx}`,
    `Q ${right} ${bottom} ${right - rx} ${bottom}`,
    `L ${left + rx} ${bottom}`,
    `Q ${left} ${bottom} ${left} ${bottom - rx}`,
    "Z",
  ].join(" ");
}

/** A polygon with uniformly rounded corners; pass the full outline clockwise. */
function roundedPolygon(points: Pt[], radius: number): string {
  const commands: string[] = [];
  const count = points.length;

  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count]!;
    const current = points[index]!;
    const next = points[(index + 1) % count]!;
    commands.push(
      index === 0 ? `M ${fmt(along(current, previous, radius))}` : `L ${fmt(along(current, previous, radius))}`,
      `Q ${fmt(current)} ${fmt(along(current, next, radius))}`,
    );
  }

  return `${commands.join(" ")} Z`;
}

function along(from: Pt, toward: Pt, distance: number): Pt {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const step = Math.min(distance, length / 2);
  return [from[0] + (dx / length) * step, from[1] + (dy / length) * step];
}

/** A tapered feature: wide at the base, rounded at the tip. Mirror its pair. */
function taper(base: Pt, tip: Pt, halfWidth: number): string {
  const dx = tip[0] - base[0];
  const dy = tip[1] - base[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const at = (t: number, side: number, width: number): Pt => [
    base[0] + dx * t + px * side * width,
    base[1] + dy * t + py * side * width,
  ];
  return [
    `M ${fmt(at(0, 1, halfWidth))}`,
    `L ${fmt(at(0.9, 1, halfWidth * 0.34))}`,
    `Q ${fmt(at(1, 0, halfWidth * 0.3))} ${fmt(at(0.9, -1, halfWidth * 0.34))}`,
    `L ${fmt(at(0, -1, halfWidth))}`,
    "Z",
  ].join(" ");
}

/** A doorway: semicircular top on straight sides, flat base. */
function arch(width: number, top: number, base: number): string {
  const radius = width / 2;
  const arcCentre = top + radius;
  const points: Pt[] = [[CENTRE - radius, base], [CENTRE - radius, arcCentre]];

  for (let index = 0; index <= 48; index += 1) {
    const angle = Math.PI - (index / 48) * Math.PI;
    points.push([CENTRE + radius * Math.cos(angle), arcCentre - radius * Math.sin(angle)]);
  }

  points.push([CENTRE + radius, base]);
  return `M ${points.map(fmt).join(" L ")} Z`;
}

function fmt(point: Pt): string {
  return `${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
}

interface Draft {
  id: string;
  name: string;
  note: string;
  parts: string[];
  eyes: { x: number; y: number; spacing: number; scale: number };
}

const eyes = (y: number, spacing = 20, scale = 1.36): Draft["eyes"] => ({
  x: CENTRE,
  y,
  spacing,
  scale,
});

function orb(cy = 50, radius = SPAN / 2): string {
  return circle(CENTRE, cy, radius);
}

const DRAFTS: Draft[] = [
  {
    id: "orb",
    name: "Orb",
    note: "A perfect circle",
    parts: [orb()],
    eyes: eyes(46),
  },
  {
    id: "squircle",
    name: "Squircle",
    note: "Rounded square, 0.28 corners",
    parts: [
      roundedPolygon(
        [
          [SAFE_MIN, SAFE_MIN],
          [SAFE_MAX, SAFE_MIN],
          [SAFE_MAX, SAFE_MAX],
          [SAFE_MIN, SAFE_MAX],
        ],
        SPAN * 0.28,
      ),
    ],
    eyes: eyes(50),
  },
  {
    id: "drop",
    name: "Drop",
    note: "Teardrop, point up, widest at 0.42",
    parts: [superellipse(50, SPAN * 0.46, SPAN / 2, 1.22, 2.3)],
    eyes: eyes(50),
  },
  {
    id: "bell",
    name: "Bell",
    note: "Narrow rounded top flaring to a wide base",
    parts: [
      superellipse(38, 30, 34, 2.5, 2.5),
      roundedPolygon(
        [
          [12, 52],
          [88, 52],
          [94, SAFE_MAX],
          [SAFE_MIN, SAFE_MAX],
        ],
        12,
      ),
    ],
    eyes: eyes(38, 19, 1.3),
  },
  {
    id: "arch",
    name: "Arch",
    note: "Semicircular top on straight sides, flat base",
    parts: [arch(SPAN, 6, SAFE_MAX)],
    eyes: eyes(50),
  },
  {
    id: "hexa",
    name: "Hexa",
    note: "Soft hexagon, flat top and bottom",
    parts: [
      roundedPolygon(
        [
          [26, SAFE_MIN],
          [74, SAFE_MIN],
          [SAFE_MAX, 50],
          [74, SAFE_MAX],
          [26, SAFE_MAX],
          [SAFE_MIN, 50],
        ],
        SPAN * 0.18,
      ),
    ],
    eyes: eyes(52),
  },
  {
    id: "pill",
    name: "Pill",
    note: "Vertical capsule, 0.78:1",
    parts: [capsule(50, SPAN * 0.78, SPAN)],
    eyes: eyes(45),
  },
  {
    id: "gem",
    name: "Gem",
    note: "Faceted: flat table, chamfered crown, flat base",
    parts: [
      roundedPolygon(
        [
          [32, 22],
          [68, 22],
          [SAFE_MAX, 44],
          [70, 82],
          [30, 82],
          [SAFE_MIN, 44],
        ],
        5,
      ),
    ],
    eyes: eyes(44, 18, 1.28),
  },
  {
    id: "crest",
    name: "Crest",
    note: "Orb with one centred crest ridge",
    parts: [orb(56, 37), roundedPolygon([[35, 26], [65, 26], [61, 12], [39, 12]], 5)],
    eyes: eyes(58, 19, 1.3),
  },
  {
    id: "horns",
    name: "Horns",
    note: "Orb with two horn nubs at 11 and 1",
    parts: [orb(56, 37), taper([33, 32], [27, 9], 7), taper([67, 32], [73, 9], 7)],
    eyes: eyes(58, 19, 1.3),
  },
  {
    id: "antennae",
    name: "Antennae",
    note: "Orb with two stalks and round tips",
    parts: [
      orb(58, 35),
      taper([37, 34], [31, 15], 2.6),
      taper([63, 34], [69, 15], 2.6),
      circle(31, 13, 4),
      circle(69, 13, 4),
    ],
    eyes: eyes(60, 18, 1.28),
  },
  {
    id: "scallop",
    name: "Scallop",
    note: "Squircle with a crown of three bumps",
    parts: [
      roundedPolygon(
        [
          [SAFE_MIN, 26],
          [SAFE_MAX, 26],
          [SAFE_MAX, SAFE_MAX],
          [SAFE_MIN, SAFE_MAX],
        ],
        SPAN * 0.26,
      ),
      circle(50, 18, 12),
      circle(27, 24, 9),
      circle(73, 24, 9),
    ],
    eyes: eyes(56, 19, 1.3),
  },
  {
    id: "shoulder",
    name: "Shoulder",
    note: "Wide shoulders narrowing to a rounded top",
    parts: [superellipse(50, SPAN / 2, SPAN / 2, 3.2, 4.6)],
    eyes: eyes(48),
  },
];

/** Fits a composed silhouette into the safe area, keeping it symmetric. */
function fit(path: string): { path: string; scale: number; dx: number; dy: number } {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    xs.push(numbers[index]!);
    ys.push(numbers[index + 1]!);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(SPAN / (maxX - minX || 1), SPAN / (maxY - minY || 1));
  const dx = CENTRE - ((minX + maxX) / 2) * scale;
  const dy = CENTRE - ((minY + maxY) / 2) * scale;

  let cursor = 0;
  const fitted = path.replace(/-?\d+(?:\.\d+)?/g, (token) => {
    const value = Number(token) * scale + (cursor % 2 === 0 ? dx : dy);
    cursor += 1;
    return value.toFixed(2);
  });

  return { path: fitted, scale, dx, dy };
}

function build(draft: Draft): AvatarShape {
  const fitted = fit(draft.parts.join(" "));
  return {
    id: draft.id,
    name: draft.name,
    note: draft.note,
    definition: {
      version: 1,
      id: draft.id,
      name: draft.name,
      body: { path: fitted.path },
      eyes: {
        x: draft.eyes.x * fitted.scale + fitted.dx,
        y: draft.eyes.y * fitted.scale + fitted.dy,
        spacing: draft.eyes.spacing * fitted.scale,
        scale: draft.eyes.scale * fitted.scale * 1.2,
      },
    } satisfies AvatarDefinition,
  };
}

export const SHAPES: readonly AvatarShape[] = DRAFTS.map(build);

export const SHAPE_IDS = SHAPES.map((shape) => shape.id);

export const DEFAULT_SHAPE = "orb";

const byId = new Map(SHAPES.map((shape) => [shape.id, shape]));

export function isShapeId(value: string): boolean {
  return byId.has(value);
}

export function shapeDefinition(id: string): AvatarDefinition {
  const shape = byId.get(id) ?? byId.get(DEFAULT_SHAPE);
  if (!shape) throw new Error("no avatar shapes are registered");
  return shape.definition;
}

export function shapeById(id: string): AvatarShape {
  return byId.get(id) ?? byId.get(DEFAULT_SHAPE)!;
}
