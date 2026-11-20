import { bubbleHex, isColorId } from "./colors.ts";
import type { AvatarColorId } from "./types.ts";

/**
 * Derive a user-bubble accent from an avatar/body colour.
 *
 * Canonical palette ids use the spec's fixed bubble hex. For arbitrary colours
 * we approximate the spec rule in OKLCH: target lightness = min(L, 0.34) with
 * chroma/hue preserved. (See handoffs/spec/avatars.json and deviations.md.)
 */
export function deriveAccent(color: string): string {
  if (isColorId(color)) return bubbleHex(color as AvatarColorId);
  const rgb = parseHex(color);
  if (!rgb) return color;

  const oklch = rgbToOklch(rgb);
  if (oklch.l <= 0.34) return toHexString(color);
  oklch.l = 0.34;
  return oklchToHex(oklch);
}

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

type Oklch = { l: number; c: number; h: number };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, c)) * 255);
}

function rgbToOklch({ r, g, b }: { r: number; g: number; b: number }): Oklch {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.sqrt(a * a + b2 * b2);
  let h = (Math.atan2(b2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: C, h };
}

function oklchToHex({ l, c, h }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return `#${toHex(linearToSrgb(r))}${toHex(linearToSrgb(g))}${toHex(linearToSrgb(bl))}`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function toHexString(hex: string): string {
  const p = parseHex(hex);
  return p ? `#${toHex(p.r)}${toHex(p.g)}${toHex(p.b)}` : hex;
}
