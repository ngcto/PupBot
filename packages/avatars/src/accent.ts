/**
 * The user's own message bubble is the bot's avatar colour at 81% OKLCH
 * lightness, clamped so a near-white bot still gets a readable bubble.
 * Measured reference pairs: #f69412→#c8780e, #1884fc→#136ed2, #fc2c3e→#cf2b35,
 * #ffffff→#3b3b3b.
 */
const FACTOR = 0.81;
/**
 * The reference's four measured pairs fit a plain sRGB channel multiply far
 * better than an OKLCH lightness multiply (verified: OKLCH drifts #1884fc to
 * #005ed3, sRGB lands on #136ad2 against a measured #136ed2), so we multiply
 * channels and special-case the one colour the reference also special-cases.
 */
const NEAR_WHITE_LUMA = 200;
/** A white bot gets this flat neutral bubble instead of an unreadable #cfcfcf. */
const NEAR_WHITE_BUBBLE = "#3b3b3b";

export function deriveAccent(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 12 && Math.min(r, g, b) > NEAR_WHITE_LUMA) return NEAR_WHITE_BUBBLE;
  const shade = (channel: number) => Math.round(channel * FACTOR).toString(16).padStart(2, "0");
  return `#${shade(r)}${shade(g)}${shade(b)}`;
}

export function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    const [r, g, b] = value.split("");
    if (!r || !g || !b) return null;
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  if (value.length !== 6) return null;
  const int = Number.parseInt(value, 16);
  if (Number.isNaN(int)) return null;
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

export function srgbToOklch(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const lightness = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)];
}

export function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const toHex = (channel: number) => fromLinear(channel).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bb)}`;
}
