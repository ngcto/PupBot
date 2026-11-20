import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, AvatarShapeId } from "./types.ts";

const EYE_INK = "#121212";
const MIN_SIZE = 16;

/**
 * One frame, one string. The server and the browser call exactly this, so the
 * markup is identical; `time` is pinned and motion frozen.
 */
export function renderAvatarSvg({ shape, color, size = 96 }: AvatarRenderInput): string {
  const definition = shapeDefinition(shape);
  const rendered = Math.max(MIN_SIZE, size);
  const svg = renderBase(definition, {
    color: resolveColor(color),
    eyeColor: EYE_INK,
    size: rendered,
    depth: 5,
    motion: "idle",
    time: 0,
    reducedMotion: true,
  });

  return svg.replaceAll(`fill="${EYE_INK}"`, `fill="${EYE_INK}" fill-opacity="0.9"`);
}

/** Fails loudly at import time if a shape ever drifts from the library contract. */
export function assertShapeContract(ids: readonly string[]): void {
  for (const id of ids) {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    if (!result.ok) throw new Error(`avatar shape ${id} is invalid: ${result.errors.join("; ")}`);
  }
}
