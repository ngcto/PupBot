import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { eyeCapsules, eyeMarkup } from "./eyes.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput } from "./types.ts";

const MIN_SIZE = 16;
const INK = "#151515";

/**
 * How far the drawn body leans, in degrees, negative being counter-clockwise:
 * the reference set leans to the left. Measured two ways that agree — Ng's
 * screenshot traced and rotation-matched against its levelled revision gives 12°
 * (median of the clean-edged shapes, 11.6°), and at matched optical size, comparing
 * every glyph's silhouette against the closest reference cell gives a plateau from
 * −12° to −16° (IoU 0.7101 at −12, 0.7106 at −14, 0.7100 at −16) that beats level
 * (0.6856) and the old clockwise turn (0.6733). The plateau's peak is inside its own
 * noise, so the measured 12° stands.
 *
 * Only the body turns. The eye pair is drawn after this, upright and in the same
 * place, so the pair keeps the screen orientation it was fitted with; the body leans
 * under it.
 */
export const GLYPH_LEAN_DEG = -12;

/**
 * One frame, one string. The server and the browser call exactly this, so the
 * markup is identical; `time` is pinned and motion frozen. Colour, depth and body
 * are the package's own; the eye pair is ours.
 */
export function renderAvatarSvg({ shape, color, size = 96 }: AvatarRenderInput): string {
  const definition = shapeDefinition(shape);
  const rendered = renderBase(definition, {
    color: resolveColor(color),
    size: Math.max(MIN_SIZE, size),
    motion: "idle",
    time: 0,
    reducedMotion: true,
  });

  return drawEyes(leanGlyph(replaceEyes(rendered, definition)), definition);
}

/**
 * Takes the package's two eye groups out of the frame and reports the matrix they
 * were drawn under, so the replacement lands in the same place. The package's eyes
 * are two plain vertical ovals sitting level; ours are asymmetric slanted capsules,
 * and the definition itself stays untouched.
 */
function replaceEyes(svg: string, definition: { id: string }): { body: string; matrix: string | null } {
  const groups = inkGroups(svg).reverse();
  let matrix: string | null = null;
  let body = svg;
  for (const { start, end } of groups) {
    const group = body.slice(start, end);
    const drawn = /transform="([^"]+)"/.exec(group.slice(0, group.indexOf(">") + 1));
    if (!matrix) matrix = drawn?.[1] ?? null;
    body = `${body.slice(0, start)}${body.slice(end)}`;
  }
  if (groups.length === 0) {
    throw new Error(`open-bot-avatar changed its eye markup for "${definition.id}"; the eye layer cannot replace it`);
  }
  return { body, matrix };
}

/**
 * Turns the drawn body inside its frame. Everything after the definitions rotates
 * about the middle of the 0..100 box; the definitions themselves stay as written, so
 * a re-vendor is still mechanical. The eye layer is added afterwards and does not turn.
 */
function leanGlyph({ body, matrix }: { body: string; matrix: string | null }): { body: string; matrix: string | null } {
  const closed = body.indexOf("</defs>");
  const end = body.lastIndexOf("</svg>");
  if (closed === -1 || end === -1) {
    throw new Error("open-bot-avatar markup changed shape; the glyph lean cannot be applied");
  }
  const start = closed + "</defs>".length;
  const turned = `${body.slice(0, start)}<g transform="rotate(${GLYPH_LEAN_DEG} 50 50)">${body.slice(start, end)}</g>${body.slice(end)}`;
  return { body: turned, matrix };
}

/** Appends our pair, under the same matrix the package drew the eyes beneath the body transform. */
function drawEyes({ body, matrix }: { body: string; matrix: string | null }, definition: Parameters<typeof eyeCapsules>[0]): string {
  const ink = `#${INK.replace("#", "")}`;
  const capsules = eyeCapsules(definition).map((capsule) => eyeMarkup(capsule, ink)).join("");
  const layer = matrix ? `<g transform="${matrix}">${capsules}</g>` : capsules;
  const end = body.lastIndexOf("</svg>");
  return `${body.slice(0, end)}${layer}${body.slice(end)}`;
}

/**
 * [start, end) of every leaf group that draws eye ink, in document order. It walks
 * every opening tag, not just the outermost, because the renderer nests the eye
 * groups inside the body group.
 */
function inkGroups(markup: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let start = markup.indexOf("<g ");
  while (start !== -1) {
    let depth = 0;
    let index = start;
    while (index < markup.length) {
      if (markup.startsWith("<g ", index)) {
        depth += 1;
        index += 3;
      } else if (markup.startsWith("</g>", index)) {
        depth -= 1;
        index += 4;
        if (depth === 0) break;
      } else {
        index += 1;
      }
    }
    const inner = markup.slice(start, index);
    if (inner.includes(`fill="${INK}"`) && !inner.slice(2).includes("<g ")) found.push({ start, end: index });
    start = markup.indexOf("<g ", start + 3);
  }
  return found;
}

/** Fails loudly at import time if a shape ever drifts from the library contract. */
export function assertShapeContract(ids: readonly string[]): void {
  for (const id of ids) {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    if (!result.ok) throw new Error(`avatar shape ${id} is invalid: ${result.errors.join("; ")}`);
  }
}
