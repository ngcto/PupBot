import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, AvatarShapeId } from "./types.ts";

const MIN_SIZE = 16;

/**
 * How far the glyph leans clockwise, in degrees: the reference set reads toward
 * the upper right, and its neck of the look is a tilted body under level eyes.
 *
 * Measured from Ng's Grok Bot screenshot, not guessed. The screenshot's own trace
 * (`handoffs/avatars-grok/shapes.json`) was rotation-matched against the levelled
 * revision of the same trace (`shapes-flat.json`), one shape at a time, and the
 * angle that best reproduces the screenshot came out at 12.25° for `square`,
 * 14° for `hexagon`, 11.25° for `cloud` and `pill`, 10° for `house`, and 5–8° for
 * the lobed shapes, whose best fit is shallower. The clean-edged shapes cluster at
 * 11–14° and the median of the eight is 11.6°, so the dominant tilt is 12°.
 *
 * It is applied to the drawn glyph only, about the middle of the frame, so the
 * definition stays exactly the package's (or the vendored JSON's) and a re-vendor
 * stays mechanical. Nothing else in the SVG moves: the title and defs stay put.
 */
export const GLYPH_TILT_DEG = 12;

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
 * Wraps everything after the definitions in one rotation, about the middle of the
 * 0..100 box. Every glyph stays inside the frame at 12°: the widest drawn extent
 * after the turn is `witch-hat` at 47.25 units from the middle of a 50-unit half
 * box, and `camera` (44.5), `chat` (42.75) and `cloud` (42.5) follow.
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
export function assertShapeContract(ids: readonly string[]): void {
  for (const id of ids) {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    if (!result.ok) throw new Error(`avatar shape ${id} is invalid: ${result.errors.join("; ")}`);
  }
}
