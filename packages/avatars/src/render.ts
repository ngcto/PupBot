import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, AvatarShapeId } from "./types.ts";

const MIN_SIZE = 16;

/**
 * How far the glyph leans, in degrees, negative being counter-clockwise: the
 * reference set reads toward the upper left, and its neck of the look is a tilted
 * body under level eyes.
 *
 * Measured from Ng's Grok Bot screenshot, not guessed. The screenshot's own trace
 * (`handoffs/avatars-grok/shapes.json`) was rotation-matched against the levelled
 * revision of the same trace (`shapes-flat.json`), one shape at a time, and the
 * angle that best reproduces the screenshot came out at 12.25° for `square`,
 * 14° for `hexagon`, 11.25° for `cloud` and `pill`, 10° for `house`, and 5–8° for
 * the lobed shapes, whose best fit is shallower. The clean-edged shapes cluster at
 * 11–14° and the median of the eight is 11.6°, so the dominant lean is 12°.
 *
 * The match returned the angle's magnitude only and the first cut applied it the
 * wrong way round, leaning the glyphs right; Ng caught it against the reference.
 * The magnitude stands, the sign does not.
 *
 * It is applied to the drawn glyph only, about the middle of the frame, so the
 * definition stays exactly the package's (or the vendored JSON's) and a re-vendor
 * stays mechanical. Nothing else in the SVG moves: the title and defs stay put.
 */
export const GLYPH_TILT_DEG = -12;

/**
 * One frame, one string. The server and the browser call exactly this, so the
 * markup is identical; `time` is pinned and motion frozen. Colour, eyes, depth
 * and ink are the package's own: the definition carries the eye placement and
 * the renderer supplies the rest.
 */
export function renderAvatarSvg({ shape, color, size = 96 }: AvatarRenderInput): string {
  const rendered = renderBase(shapeDefinition(shape), {
    color: resolveColor(color),
    size: Math.max(MIN_SIZE, size),
    motion: "idle",
    time: 0,
    reducedMotion: true,
  });

  return tiltGlyph(rendered);
}

/**
 * Wraps everything after the definitions in one rotation about the middle of the
 * 0..100 box. Every glyph stays inside the frame at 12°: the widest drawn extent
 * after the turn is `witch-hat` at 48.44 units from the middle of a 50-unit half
 * box, and `bull` (47.5), `sprout` (46.9) and `camera` (45) follow.
 *
 * The eyes are left exactly where the package draws them. Nudging the pair toward
 * the upper left — the mirror of the first cut — does not survive this geometry:
 * the package places it a little right of centre, and the counter-clockwise turn
 * pulls the top-left edge in, so the ink runs out of body almost immediately
 * (`bunny` goes from 0.9 units of clearance at rest to 0.35 at 2, `rocket` and
 * `witch-hat` are outside the silhouette at 5). The lean carries the look on its
 * own, as it does in the reference.
 */
function tiltGlyph(svg: string): string {
  const closed = svg.indexOf("</defs>");
  const end = svg.lastIndexOf("</svg>");
  if (closed === -1 || end === -1) {
    throw new Error("open-bot-avatar markup changed shape; the glyph tilt cannot be applied");
  }
  const start = closed + "</defs>".length;
  return `${svg.slice(0, start)}<g transform="rotate(${GLYPH_TILT_DEG} 50 50)">${svg.slice(start, end)}</g>${svg.slice(end)}`;
}

/** Fails loudly at import time if a shape ever drifts from the library contract. */
