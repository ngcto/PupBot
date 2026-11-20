import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, Shape } from "./types.ts";

const EYE_FILL = "#121212";
const EYE_OPACITY = 0.9;

/** Render a PupBot avatar to an SVG string. Unknown shapes fall back to `circle`. */
export function renderAvatarSvg(input: AvatarRenderInput): string {
  const definition = shapeDefinition(input.shape) ?? shapeDefinition("circle");
  if (!definition) {
    throw new Error(`Unknown avatar shape: ${input.shape}`);
  }

  const { size = 64, title } = input;
  const labelled = title !== "" && title !== undefined;
  const color = resolveColor(input.color);
  const accessibility = labelled ? `role="img"` : `aria-hidden="true"`;
  const titleElement = labelled ? `<title>${escapeXml(title)}</title>` : "";

  const silhouette = definition.parts.map((part) => renderPart(part)).join("");
  const eyes = definition.eyes
    .map((eye) => {
      const rx = eye.w / 2;
      return `<rect class="eye-slot" x="${fmt(eye.x)}" y="${fmt(eye.y)}" width="${fmt(eye.w)}" height="${fmt(eye.h)}" rx="${fmt(rx)}" fill="${EYE_FILL}" fill-opacity="${EYE_OPACITY}"/>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" ${accessibility} fill="${escapeAttr(color)}">`,
    titleElement,
    `<g fill="${escapeAttr(color)}">`,
    silhouette,
    `</g>`,
    eyes,
    `</svg>`,
  ].join("");
}

function renderPart(part: Shape): string {
  switch (part.kind) {
    case "circle":
      return `<circle cx="${fmt(part.cx)}" cy="${fmt(part.cy)}" r="${fmt(part.r)}"/>`;
    case "ellipse":
      return `<ellipse cx="${fmt(part.cx)}" cy="${fmt(part.cy)}" rx="${fmt(part.rx)}" ry="${fmt(part.ry)}"/>`;
    case "rect": {
      const rx = part.r ?? 0;
      const rxAttr = rx ? ` rx="${fmt(rx)}"` : "";
      return `<rect x="${fmt(part.x)}" y="${fmt(part.y)}" width="${fmt(part.w)}" height="${fmt(part.h)}"${rxAttr}/>`;
    }
    case "polygon":
      return `<path d="${roundedPolygonPath(part.points, part.cornerRadius ?? 0)}"/>`;
  }
}

function roundedPolygonPath(points: Array<[number, number]>, radius: number): string {
  const n = points.length;
  if (n === 0) return "";
  if (radius <= 0 || n < 3) {
    return `M ${pts(points[0]!)} L ${points.slice(1).map(pts).join(" L ")} Z`;
  }
  const p = points.map(([x, y]) => ({ x, y }));
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = p[(i + n - 1) % n]!;
    const cur = p[i]!;
    const next = p[(i + 1) % n]!;
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    const angle = Math.acos(dot); // angle between edges at corner
    const tanHalf = Math.tan(angle / 2) || 1e-6;
    let off = Math.abs(radius / tanHalf);
    off = Math.min(off, l1 / 2, l2 / 2, radius * 3);
    if (!(off > 0) || !Number.isFinite(off)) off = Math.min(l1, l2) / 4;
    const ax = cur.x + (v1x / l1) * off;
    const ay = cur.y + (v1y / l1) * off;
    const bx = cur.x + (v2x / l2) * off;
    const by = cur.y + (v2y / l2) * off;
    if (i === 0) d += `M ${fmt(ax)} ${fmt(ay)}`;
    else d += ` L ${fmt(ax)} ${fmt(ay)}`;
    d += ` Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(bx)} ${fmt(by)}`;
  }
  d += " Z";
  return d;
}

function pts(p: [number, number]): string {
  return `${fmt(p[0])} ${fmt(p[1])}`;
}

function fmt(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return Number.isInteger(r) ? String(r) : String(r);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, "&quot;");
}
