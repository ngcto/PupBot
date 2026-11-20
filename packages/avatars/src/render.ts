import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, AvatarShapeId } from "./types.ts";

const EYE_INK = "#121212";

/**
 * One frame, one string. The server and the browser call exactly this, so the
 * markup is identical; `time` is pinned and motion frozen.
 */
export function renderAvatarSvg({ shape, color, size = 96, nose = false }: AvatarRenderInput): string {
  const definition = shapeDefinition(shape);
  const svg = renderBase(definition, {
    color: resolveColor(color),
    eyeColor: EYE_INK,
    size,
    depth: 5,
    motion: "idle",
    time: 0,
    reducedMotion: true,
  });

  const inked = svg.replaceAll(`fill="${EYE_INK}"`, `fill="${EYE_INK}" fill-opacity="0.9"`);
  return nose && size >= 48 ? withNose(inked, definition.eyes) : inked;
}

function withNose(svg: string, eyes: { x: number; y: number; spacing: number; scale: number }): string {
  const width = 7 * eyes.scale;
  const height = 5 * eyes.scale;
  const cx = eyes.x;
  const cy = eyes.y + 15 * eyes.scale;
  const nose = `<ellipse cx="${cx}" cy="${cy}" rx="${width / 2}" ry="${height / 2}" fill="${EYE_INK}" fill-opacity="0.75"/>`;
  return svg.replace("</svg>", `${nose}</svg>`);
}

/** Fails loudly at import time if a shape ever drifts from the library contract. */
export function assertShapeContract(ids: readonly AvatarShapeId[]): void {
  for (const id of ids) {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    if (!result.ok) throw new Error(`avatar shape ${id} is invalid: ${result.errors.join("; ")}`);
  }
}
