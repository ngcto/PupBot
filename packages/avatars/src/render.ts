import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { eyeCapsules, eyeMarkup } from "./eyes.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput } from "./types.ts";

const MIN_SIZE = 16;
const INK = "#151515";

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

  return drawEyes(replaceEyes(rendered, definition), definition);
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
