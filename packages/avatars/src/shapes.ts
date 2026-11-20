import type { AvatarDefinition, AvatarShape, AvatarShapeId } from "./types.ts";

type Pt = [number, number];
/** x, y and an optional corner radius. Without one the corner rounds as far as its neighbours allow. */
type Vertex = [number, number, number?];

const K = 0.5522847498;
const fmt = (n: number) => n.toFixed(2);

/**
 * One closed contour through the vertices with every corner rounded by a
 * cubic. A head is one polygon, so ears and muzzle belong to the same outline
 * instead of being unioned in, and every shape in the litter gets the same
 * corner treatment: wide soft curves for the skull, a small radius for ear tips.
 */
function outline(vertices: Vertex[]): string {
  const count = vertices.length;
  const corners = vertices.map(([x, y, radius], i) => {
    const prev = vertices[(i + count - 1) % count] as Vertex;
    const next = vertices[(i + 1) % count] as Vertex;
    const lengthIn = Math.hypot(x - prev[0], y - prev[1]);
    const lengthOut = Math.hypot(next[0] - x, next[1] - y);
    const cap = Math.min(lengthIn, lengthOut) / 2;
    const r = Math.min(radius ?? cap, cap);
    const start: Pt = [x + ((prev[0] - x) / lengthIn) * r, y + ((prev[1] - y) / lengthIn) * r];
    const end: Pt = [x + ((next[0] - x) / lengthOut) * r, y + ((next[1] - y) / lengthOut) * r];
    const c1: Pt = [start[0] + (x - start[0]) * K, start[1] + (y - start[1]) * K];
    const c2: Pt = [end[0] + (x - end[0]) * K, end[1] + (y - end[1]) * K];
    return { start, end, c1, c2 };
  });
  const p = (pt: Pt) => `${fmt(pt[0])} ${fmt(pt[1])}`;
  const first = corners[0];
  if (!first) throw new Error("an outline needs vertices");
  const parts = [`M ${p(first.start)}`];
  corners.forEach((corner, i) => {
    if (i > 0) parts.push(`L ${p(corner.start)}`);
    parts.push(`C ${p(corner.c1)} ${p(corner.c2)} ${p(corner.end)}`);
  });
  parts.push("Z");
  return parts.join(" ");
}

/** Right half from the top-centre vertex to the bottom-centre vertex; the left half is its mirror. */
function symmetric(half: Vertex[], axis = 50): Vertex[] {
  const mirrored = half
    .slice(1, -1)
    .reverse()
    .map(([x, y, r]): Vertex => [2 * axis - x, y, r]);
  return [...half, ...mirrored];
}

function rotate(vertices: Vertex[], degrees: number, about: Pt = [50, 50]): Vertex[] {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return vertices.map(([x, y, r]): Vertex => {
    const dx = x - about[0];
    const dy = y - about[1];
    return [about[0] + dx * cos - dy * sin, about[1] + dx * sin + dy * cos, r];
  });
}

/** A bumpy ring: peaks round, valleys tight. Peak 0 sits at twelve o'clock. */
function scallop(cx: number, cy: number, outer: number, inner: number, bumps: number, flatten = 1): Vertex[] {
  const out: Vertex[] = [];
  for (let k = 0; k < bumps * 2; k += 1) {
    const angle = -Math.PI / 2 + (k * Math.PI) / bumps;
    const radius = k % 2 === 0 ? outer : inner;
    out.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius * flatten, k % 2 === 0 ? undefined : 2]);
  }
  return out;
}

interface Draft {
  id: AvatarShapeId;
  name: string;
  note: string;
  vertices: Vertex[];
  /** Position in the authored space; spacing and scale are final viewBox units. */
  eyes: { x: number; y: number; spacing: number; scale: number };
}

/**
 * The renderer wants geometry inside 8..92. Scale each silhouette so its
 * bounding box fills that square along the long side and centre it, then move
 * the eyes with it. Every command is absolute and every number alternates x, y.
 */
const SAFE_MIN = 8;
const SAFE_MAX = 92;

interface Fit {
  path: string;
  scale: number;
  dx: number;
  dy: number;
}

function fitPath(path: string): Fit {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = numbers.filter((_, i) => i % 2 === 0);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = SAFE_MAX - SAFE_MIN;
  const scale = Math.min(span / (maxX - minX || 1), span / (maxY - minY || 1));
  const dx = 50 - ((minX + maxX) / 2) * scale;
  const dy = 50 - ((minY + maxY) / 2) * scale;

  let index = 0;
  const moved = path.replace(/-?\d+(?:\.\d+)?/g, (match) => {
    const value = Number(match) * scale + (index % 2 === 0 ? dx : dy);
    index += 1;
    return fmt(value);
  });
  return { path: moved, scale, dx, dy };
}

function build(draft: Draft): AvatarShape {
  const fitted = fitPath(outline(draft.vertices));
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
        spacing: draft.eyes.spacing,
        scale: draft.eyes.scale,
      },
    },
  };
}

const eyes = (x: number, y: number, spacing = 12, scale = 1.36): Draft["eyes"] => ({ x, y, spacing, scale });

const shaggy = scallop(50, 50, 45, 36, 7);
shaggy.splice(7, 1, [43, 92, 4], [57, 92, 4]);

export const SHAPES: readonly AvatarShape[] = [
  build({
    id: "pup",
    name: "Pup",
    note: "Round head, chin bump, wide forward-folded ear flaps on the sides, small centred snout",
    vertices: symmetric([[50,10],[68,12,14],[76,22,4],[92,26,8],[98,40,9],[90,52,8],[80,50,2],[82,66,14],[68,90,12],[57,98,6],[50,98]]),
    eyes: eyes(50, 54),
  }),
  build({
    id: "fold",
    name: "Fold",
    note: "Long floppy ears past the jaw, short muzzle with an underbite",
    vertices: symmetric([[50,8],[62,8,12],[72,12,8],[88,20,10],[98,44,10],[98,76,10],[92,96,9],[80,94,6],[70,50,2],[72,66,10],[66,80,10],[58,88,8],[50,90]]),
    eyes: eyes(50, 52),
  }),
  build({
    id: "point",
    name: "Point",
    note: "Domed skull, thick outward-leaning ears, flat-bottomed blunt muzzle",
    vertices: symmetric([[50,20,16],[62,22,8],[66,30,3],[84,4,9],[96,36,9],[98,58,14],[88,78,12],[70,88,8],[66,100,8],[50,100]]),
    eyes: eyes(50, 60),
  }),
  build({
    id: "flop",
    name: "Flop",
    note: "One ear up, one folded across, muzzle offset left, head tilted",
    vertices: rotate([[46,14,12],[58,14,10],[60,16,8],[78,0,5],[90,32,8],[93,54,12],[86,76,12],[68,90,12],[52,92,8],[44,99,6],[32,99,6],[24,88,8],[20,72,12],[22,50,2],[12,62,8],[8,46,10],[12,28,10],[24,18,8],[38,14,12]], 4),
    eyes: eyes(50, 54),
  }),
  build({
    id: "tuft",
    name: "Tuft",
    note: "Two rounded outward-leaning ears with a fur tuft between, blunt short muzzle",
    vertices: symmetric([[50,6,10],[58,20,5],[64,24,3],[84,8,12],[96,36,10],[98,58,14],[90,78,12],[72,88,8],[66,98,8],[50,98]]),
    eyes: eyes(50, 58),
  }),
  build({
    id: "snout",
    name: "Snout",
    note: "Profile-leaning, ears swept back, long muzzle to the right edge",
    vertices: [[42,12,14],[60,16,12],[70,36,8],[94,40,6],[100,52,8],[98,68,8],[72,74,6],[62,88,12],[42,94,14],[26,86,12],[20,70,10],[18,52,2],[2,52,7],[6,30,10],[22,16,12]],
    eyes: eyes(42, 48),
  }),
  build({
    id: "pug",
    name: "Pug",
    note: "Wide low head with cheek bulges, small round ears high and close",
    vertices: symmetric([[50,10],[62,11,10],[68,8,4],[78,2,8],[88,10,8],[92,28,8],[100,54,14],[96,72,10],[80,80,4],[70,88,8],[50,88]]),
    eyes: eyes(50, 50, 22),
  }),
  build({
    id: "dane",
    name: "Dane",
    note: "Tall narrow head, thick outward-leaning ears, long blunt jaw",
    vertices: symmetric([[50,20,14],[60,22,6],[64,28,3],[78,4,8],[91,34,8],[91,56,12],[82,72,8],[76,80,3],[74,100,8],[50,100]]),
    eyes: eyes(50, 42, 10, 1.19),
  }),
  build({
    id: "bun",
    name: "Bun",
    note: "Top-knot with ears drooping from under it",
    vertices: symmetric([[50,2,12],[62,6,10],[64,16,6],[68,24,4],[82,30,10],[93,46,10],[92,70,9],[76,56,2],[78,72,12],[66,90,12],[50,96]]),
    eyes: eyes(50, 58),
  }),
  build({
    id: "shag",
    name: "Shag",
    note: "Scalloped fur edge, ears lost in the shag, muzzle barely breaking it",
    vertices: shaggy,
    eyes: eyes(50, 50),
  }),
  build({
    id: "squish",
    name: "Squish",
    note: "Very wide and low, ears out sideways, wide flat muzzle",
    vertices: symmetric([[50,0],[72,1,18],[86,12,12],[90,24,8],[96,28,6],[100,46,10],[94,60,6],[84,56,2],[86,66,10],[76,74,12],[62,78,8],[50,78]]),
    eyes: eyes(50, 40, 20),
  }),
  build({
    id: "vulpine",
    name: "Vulpine",
    note: "Fox-like: sharp ears over a domed brow, blunt muzzle ending in a point",
    vertices: symmetric([[50,26,14],[60,26,6],[64,30,3],[84,2,6],[94,38,6],[94,58,12],[82,76,10],[66,86,8],[54,100,4],[50,100,4]]),
    eyes: eyes(50, 56, 11, 1.28),
  }),
  build({
    id: "crown",
    name: "Crown",
    note: "Three-point crest with thick outward-leaning ears, flat-bottomed blunt muzzle",
    vertices: symmetric([[50,8,7],[58,26,3],[66,28,3],[84,4,9],[96,38,8],[98,62,12],[92,84,10],[76,92,4],[68,98,8],[50,98]]),
    eyes: eyes(50, 64),
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
