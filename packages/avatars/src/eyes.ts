import { EYE_FIT, EYE_LAYOUT } from "./eye-fit.ts";
import type { AvatarShapeId } from "./types.ts";

/** A capsule the eye layer draws: centre, long axis length, thickness, and that axis's angle. */
export interface EyeCapsule {
  cx: number;
  cy: number;
  length: number;
  width: number;
  angle: number;
}

interface Definition {
  id: string;
  body: { path: string };
  eyes: { x: number; y: number; spacing: number; scale: number };
}

const BOUNDS_CACHE = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();

/** The definition's drawn extent, from its path. Control points bound curves, so the box is never smaller than the ink. */
export function bodyBounds(path: string): { x0: number; y0: number; x1: number; y1: number } {
  const cached = BOUNDS_CACHE.get(path);
  if (cached) return cached;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of samplePath(path)) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const bounds = { x0, y0, x1, y1 };
  BOUNDS_CACHE.set(path, bounds);
  return bounds;
}

/** The two capsules, in the same 0..100 space the definitions use. */
export function eyeCapsules(definition: Definition): [EyeCapsule, EyeCapsule] {
  const { x0, y0, x1, y1 } = bodyBounds(definition.body.path);
  const radius = Math.min(x1 - x0, y1 - y0) / 2;
  const fit = EYE_FIT[definition.id] ?? { scale: 1 };
  const scale = radius * fit.scale;
  const pairX = definition.eyes.x + EYE_LAYOUT.pairOffset.x * radius + (fit.dx ?? 0) * radius;
  const pairY = definition.eyes.y + EYE_LAYOUT.pairOffset.y * radius + (fit.dy ?? 0) * radius;
  return (["near", "far"] as const).map((key) => {
    const eye = EYE_LAYOUT[key];
    return {
      cx: pairX + eye.cx * scale,
      cy: pairY + eye.cy * scale,
      length: eye.length * scale,
      width: eye.width * scale,
      angle: eye.angle,
    };
  }) as [EyeCapsule, EyeCapsule];
}

/** One capsule as markup: a rounded rect turned about its own centre. */
export function eyeMarkup(capsule: EyeCapsule, ink: string): string {
  const { cx, cy, length, width, angle } = capsule;
  const x = (cx - length / 2).toFixed(2);
  const y = (cy - width / 2).toFixed(2);
  return `<rect x="${x}" y="${y}" width="${length.toFixed(2)}" height="${width.toFixed(2)}" rx="${(width / 2).toFixed(2)}" transform="rotate(${angle} ${cx.toFixed(2)} ${cy.toFixed(2)})" fill="${ink}"/>`;
}

/** The shape ids that carry a hand fit, for the tests to pin. */
export function fittedShapes(): AvatarShapeId[] {
  return Object.keys(EYE_FIT) as AvatarShapeId[];
}

/**
 * Every point of the path, curves sampled. Only bounding needs this, so the step
 * counts are modest; arcs are converted to their centre parameterisation first.
 */
function samplePath(d: string): Array<[number, number]> {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: Array<[number, number]> = [];
  let i = 0;
  let cmd = "";
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastCtrlX = 0, lastCtrlY = 0;
  const num = () => Number(tokens[i++]);
  const push = (px: number, py: number) => out.push([px, py]);
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, m = 1 - t;
      push(
        m * m * m * x + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
      );
    }
  };
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, m = 1 - t;
      push(m * m * x + 2 * m * t * x1 + t * t * x2, m * m * y + 2 * m * t * y1 + t * t * y2);
    }
  };
  while (i < tokens.length) {
    const token: string | undefined = tokens[i];
    if (token !== undefined && /[a-zA-Z]/.test(token)) {
      cmd = token;
      i += 1;
    }
    switch (cmd) {
      case "M": x = num(); y = num(); startX = x; startY = y; push(x, y); cmd = "L"; break;
      case "m": x += num(); y += num(); startX = x; startY = y; push(x, y); cmd = "l"; break;
      case "L": x = num(); y = num(); push(x, y); break;
      case "l": x += num(); y += num(); push(x, y); break;
      case "H": x = num(); push(x, y); break;
      case "h": x += num(); push(x, y); break;
      case "V": y = num(); push(x, y); break;
      case "v": y += num(); push(x, y); break;
      case "C": {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastCtrlX = x2; lastCtrlY = y2; x = x3; y = y3; break;
      }
      case "c": {
        const x1 = x + num(), y1 = y + num(), x2 = x + num(), y2 = y + num(), x3 = x + num(), y3 = y + num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastCtrlX = x2; lastCtrlY = y2; x = x3; y = y3; break;
      }
      case "S": {
        const x1 = 2 * x - lastCtrlX, y1 = 2 * y - lastCtrlY, x2 = num(), y2 = num(), x3 = num(), y3 = num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastCtrlX = x2; lastCtrlY = y2; x = x3; y = y3; break;
      }
      case "s": {
        const x1 = 2 * x - lastCtrlX, y1 = 2 * y - lastCtrlY;
        const x2 = x + num(), y2 = y + num(), x3 = x + num(), y3 = y + num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastCtrlX = x2; lastCtrlY = y2; x = x3; y = y3; break;
      }
      case "Q": {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num();
        quad(x1, y1, x2, y2);
        lastCtrlX = x1; lastCtrlY = y1; x = x2; y = y2; break;
      }
      case "q": {
        const x1 = x + num(), y1 = y + num(), x2 = x + num(), y2 = y + num();
        quad(x1, y1, x2, y2);
        lastCtrlX = x1; lastCtrlY = y1; x = x2; y = y2; break;
      }
      case "T": {
        const x1 = 2 * x - lastCtrlX, y1 = 2 * y - lastCtrlY, x2 = num(), y2 = num();
        quad(x1, y1, x2, y2);
        lastCtrlX = x1; lastCtrlY = y1; x = x2; y = y2; break;
      }
      case "t": {
        const x1 = 2 * x - lastCtrlX, y1 = 2 * y - lastCtrlY;
        const x2 = x + num(), y2 = y + num();
        quad(x1, y1, x2, y2);
        lastCtrlX = x1; lastCtrlY = y1; x = x2; y = y2; break;
      }
      case "A":
      case "a": {
        const rx = num(), ry = num(), rotation = num(), large = num(), sweepFlag = num();
        const ex = cmd === "a" ? x + num() : num();
        const ey = cmd === "a" ? y + num() : num();
        for (const [px, py] of arcPoints(x, y, rx, ry, rotation, large, sweepFlag, ex, ey)) push(px, py);
        x = ex; y = ey; break;
      }
      case "Z":
      case "z":
        x = startX; y = startY;
        break;
      default:
        i += 1;
    }
  }
  if (out.length === 0) for (let k = 0; k <= 100; k++) push(k, k * 0.5);
  return out;
}

/** An elliptical arc as sampled points, both endpoints excluded. */
function arcPoints(
  x1: number, y1: number, rxIn: number, ryIn: number, rotation: number, large: number, sweep: number, x2: number, y2: number,
): Array<[number, number]> {
  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = large === sweep ? -1 : 1;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const numer = rx * rx * ry * ry - denom;
  const coef = sign * Math.sqrt(Math.max(0, numer) / (denom || 1));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angleOf = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angleOf(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  const delta = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  const sweepAngle = sweep ? (delta >= 0 ? delta : delta + 2 * Math.PI) : delta <= 0 ? delta : delta - 2 * Math.PI;
  const points: Array<[number, number]> = [];
  for (let s = 1; s <= 8; s++) {
    const a = theta1 + (sweepAngle * s) / 8;
    points.push([
      cx + cosPhi * rx * Math.cos(a) - sinPhi * ry * Math.sin(a),
      cy + sinPhi * rx * Math.cos(a) + cosPhi * ry * Math.sin(a),
    ]);
  }
  return points;
}
