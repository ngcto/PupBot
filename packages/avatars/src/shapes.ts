import type { AvatarDefinition, AvatarShape, AvatarShapeId } from "./types.ts";

/**
 * Geometry primitives. A definition is one filled path; subpaths overlap with
 * the nonzero rule, so a head is simply its parts written in one string and
 * they merge into a single silhouette.
 */
const K = 0.5522847498;

type Pt = [number, number];

function ellipse(cx: number, cy: number, rx: number, ry: number, rotationDeg = 0): string {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const point = (x: number, y: number): Pt => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const p = (x: number, y: number) => point(x, y).map((n) => n.toFixed(2)).join(" ");
  const kx = rx * K;
  const ky = ry * K;
  return [
    `M ${p(-rx, 0)}`,
    `C ${p(-rx, -ky)} ${p(-kx, -ry)} ${p(0, -ry)}`,
    `C ${p(kx, -ry)} ${p(rx, -ky)} ${p(rx, 0)}`,
    `C ${p(rx, ky)} ${p(kx, ry)} ${p(0, ry)}`,
    `C ${p(-kx, ry)} ${p(-rx, ky)} ${p(-rx, 0)}`,
    "Z",
  ].join(" ");
}

/** A tapered ear: straight sides into a rounded tip. */
function cone(base: Pt, tip: Pt, halfWidth: number, tipWidth = 5): string {
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
  const p = (pt: Pt) => pt.map((n) => n.toFixed(2)).join(" ");
  const a = at(0, 1, halfWidth);
  const b = at(0.86, 1, halfWidth * 0.42);
  const c = at(0.86, -1, halfWidth * 0.42);
  const d = at(0, -1, halfWidth);
  return `M ${p(a)} L ${p(b)} Q ${p(at(1, 0, tipWidth / 2))} ${p(c)} L ${p(d)} Z`;
}

/** N rounded bumps around an ellipse — fur, curls, scalloped edges. */
function scallop(cx: number, cy: number, rx: number, ry: number, bumps: number, depth: number): string {
  const step = (Math.PI * 2) / bumps;
  const points: string[] = [];
  for (let i = 0; i < bumps; i += 1) {
    const angle = -Math.PI / 2 + i * step;
    const outerX = cx + Math.cos(angle) * (rx + depth);
    const outerY = cy + Math.sin(angle) * (ry + depth);
    const nextAngle = angle + step;
    const controlX = cx + Math.cos(angle + step / 2) * (rx + depth * 1.9);
    const controlY = cy + Math.sin(angle + step / 2) * (ry + depth * 1.9);
    const toX = cx + Math.cos(nextAngle) * (rx + depth);
    const toY = cy + Math.sin(nextAngle) * (ry + depth);
    if (i === 0) points.push(`M ${outerX.toFixed(2)} ${outerY.toFixed(2)}`);
    points.push(
      `Q ${controlX.toFixed(2)} ${controlY.toFixed(2)} ${toX.toFixed(2)} ${toY.toFixed(2)}`,
    );
  }
  points.push("Z");
  return points.join(" ");
}

function roundedRect(cx: number, cy: number, width: number, height: number, radius: number): string {
  const x = cx - width / 2;
  const y = cy - height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  const right = x + width;
  const bottom = y + height;
  return [
    `M ${x + r} ${y}`,
    `L ${right - r} ${y}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `L ${right} ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `L ${x + r} ${bottom}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

interface Draft {
  id: AvatarShapeId;
  name: string;
  note: string;
  parts: string[];
  eyes: AvatarDefinition["eyes"];
}

/** The renderer keeps geometry inside 8..92; scale and centre each silhouette to use that box. */
const SAFE_MIN = 8;
const SAFE_MAX = 92;

interface Fit {
  path: string;
  scale: number;
  dx: number;
  dy: number;
}

function fitPath(path: string): Fit {
  const tokens = path.match(/[MLCQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: Pt[] = [];
  let cursor = 0;
  let command = "";
  let x = 0;
  let y = 0;

  const read = (): number => Number(tokens[cursor++] ?? 0);
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) break;
    if (/[MLCQZ]/.test(token)) {
      command = token;
      cursor += 1;
      if (command === "Z") continue;
    }
    if (command === "M" || command === "L") {
      x = read();
      y = read();
      points.push([x, y]);
    } else if (command === "Q") {
      points.push([read(), read()], [read(), read()]);
      points.push([x, y]);
    } else if (command === "C") {
      points.push([read(), read()], [read(), read()], [read(), read()]);
      points.push([x, y]);
    }
  }

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = SAFE_MAX - SAFE_MIN;
  const scale = Math.min(span / (maxX - minX || 1), span / (maxY - minY || 1));
  const dx = 50 - ((minX + maxX) / 2) * scale;
  const dy = 50 - ((minY + maxY) / 2) * scale;

  let out = 0;
  const tx = (value: number) => value * scale;
  const moved = path.replace(/-?\d+(?:\.\d+)?/g, () => {
    const value = tx(Number((path.match(/-?\d+(?:\.\d+)?/g) ?? [])[out] ?? 0));
    const delta = out % 2 === 0 ? dx : dy;
    out += 1;
    return (value + delta).toFixed(2);
  });

  return { path: moved, scale, dx, dy };
}

function build(draft: Draft): AvatarShape {
  const fitted = fitPath(draft.parts.join(" "));
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
        scale: draft.eyes.scale * fitted.scale * 1.15,
      },
    },
  };
}

const eyes = (x: number, y: number, spacing = 21, scale = 1.55): AvatarDefinition["eyes"] => ({
  x,
  y,
  spacing,
  scale,
});

export const SHAPES: readonly AvatarShape[] = [
  build({
    id: "pup",
    name: "Pup",
    note: "Round head, chin bump, short folded ears",
    parts: [
      ellipse(50, 51, 36, 34),
      ellipse(50, 72, 22, 12),
      ellipse(16, 34, 10, 15, -24),
      ellipse(84, 34, 10, 15, 24),
    ],
    eyes: eyes(50, 46),
  }),
  build({
    id: "fold",
    name: "Fold",
    note: "Long floppy ears past the jaw, short muzzle",
    parts: [
      ellipse(50, 48, 34, 37),
      ellipse(50, 70, 19, 11),
      ellipse(13, 62, 11, 26, -10),
      ellipse(87, 62, 11, 26, 10),
    ],
    eyes: eyes(50, 44, 22, 1.5),
  }),
  build({
    id: "point",
    name: "Point",
    note: "Tapered crown, upright ear tips",
    parts: [
      ellipse(50, 56, 33, 34),
      cone([33, 34], [27, 6], 12),
      cone([67, 34], [73, 6], 12),
    ],
    eyes: eyes(50, 52, 22, 1.55),
  }),
  build({
    id: "flop",
    name: "Flop",
    note: "One ear up, one folded, muzzle offset",
    parts: [
      ellipse(50, 50, 35, 35, -4),
      cone([34, 32], [25, 8], 12),
      ellipse(84, 60, 12, 22, 18),
      ellipse(46, 74, 17, 10, -6),
    ],
    eyes: eyes(48, 46, 21, 1.5),
  }),
  build({
    id: "tuft",
    name: "Tuft",
    note: "Two upright ears with a fur tuft between",
    parts: [
      ellipse(50, 54, 35, 33),
      cone([34, 32], [30, 8], 11),
      cone([66, 32], [70, 8], 11),
      ellipse(50, 22, 7, 10),
      ellipse(50, 72, 18, 10),
    ],
    eyes: eyes(50, 50, 21, 1.5),
  }),
  build({
    id: "snout",
    name: "Snout",
    note: "Long muzzle to one side, ears swept back",
    parts: [
      ellipse(44, 50, 33, 33),
      ellipse(74, 60, 24, 14, 8),
      ellipse(18, 40, 12, 16, -35),
      ellipse(26, 66, 11, 14, -25),
    ],
    eyes: eyes(42, 46, 20, 1.45),
  }),
  build({
    id: "pug",
    name: "Pug",
    note: "Wide low head with cheek bulges, tiny ears",
    parts: [
      ellipse(50, 55, 40, 30),
      ellipse(22, 60, 10, 11),
      ellipse(78, 60, 10, 11),
      ellipse(32, 27, 8, 11, -14),
      ellipse(68, 27, 8, 11, 14),
      ellipse(50, 70, 17, 9),
    ],
    eyes: eyes(50, 51, 24, 1.5),
  }),
  build({
    id: "dane",
    name: "Dane",
    note: "Tall narrow head, long jaw, tall ears",
    parts: [
      ellipse(50, 48, 29, 38),
      cone([36, 26], [33, 4], 10),
      cone([64, 26], [67, 4], 10),
      ellipse(50, 80, 16, 14),
    ],
    eyes: eyes(50, 45, 19, 1.35),
  }),
  build({
    id: "bun",
    name: "Bun",
    note: "Top-knot with ears drooping out from under it",
    parts: [
      ellipse(50, 55, 35, 32),
      ellipse(50, 24, 13, 11),
      ellipse(19, 52, 9, 19, -18),
      ellipse(81, 52, 9, 19, 18),
    ],
    eyes: eyes(50, 53, 21, 1.5),
  }),
  build({
    id: "shag",
    name: "Shag",
    note: "Scalloped fur edge, ears lost in the shag",
    parts: [scallop(50, 52, 33, 32, 7, 5), ellipse(50, 71, 17, 10)],
    eyes: eyes(50, 48, 20, 1.5),
  }),
  build({
    id: "squish",
    name: "Squish",
    note: "Very wide and low, ears out sideways",
    parts: [
      ellipse(50, 57, 42, 27),
      ellipse(10, 50, 9, 17, -60),
      ellipse(90, 50, 9, 17, 60),
      ellipse(50, 69, 20, 9),
    ],
    eyes: eyes(50, 54, 26, 1.5),
  }),
  build({
    id: "vulpine",
    name: "Vulpine",
    note: "Pointed tall head, two sharp ears, tapering muzzle",
    parts: [
      ellipse(50, 54, 30, 34),
      cone([36, 28], [28, 3], 9, 3),
      cone([64, 28], [72, 3], 9, 3),
      cone([50, 66], [50, 86], 16, 6),
    ],
    eyes: eyes(50, 50, 19, 1.4),
  }),
  build({
    id: "crown",
    name: "Crown",
    note: "Flat bottom with a three-point crest",
    parts: [
      roundedRect(50, 60, 72, 54, 24),
      cone([30, 36], [22, 10], 9),
      cone([50, 34], [50, 4], 10),
      cone([70, 36], [78, 10], 9),
    ],
    eyes: eyes(50, 57, 21, 1.5),
  }),
] as const;

export const DEFAULT_SHAPE: AvatarShapeId = "pup";

const byId = new Map(SHAPES.map((shape) => [shape.id, shape]));

export function isShapeId(value: string): value is AvatarShapeId {
  return byId.has(value as AvatarShapeId);
}

export function shapeDefinition(id: AvatarShapeId): AvatarDefinition {
  const shape = byId.get(id) ?? byId.get(DEFAULT_SHAPE);
  if (!shape) throw new Error("no avatar shapes are registered");
  return shape.definition;
}

export function shapeById(id: AvatarShapeId): AvatarShape {
  const shape = byId.get(id);
  if (!shape) throw new Error(`unknown avatar shape: ${id}`);
  return shape;
}
