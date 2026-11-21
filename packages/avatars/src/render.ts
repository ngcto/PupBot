import { renderAvatarSvg as renderBase, validateAvatar } from "open-bot-avatar";
import { resolveColor } from "./colors.ts";
import { shapeDefinition } from "./shapes.ts";
import type { AvatarRenderInput, AvatarShapeId } from "./types.ts";

const MIN_SIZE = 16;

/**
 * One frame, one string. The server and the browser call exactly this, so the
 * markup is identical; `time` is pinned and motion frozen. Colour, eyes, depth
 * and ink are the package's own: the definition carries the eye placement and
 * the renderer supplies the rest.
 */
export function renderAvatarSvg({ shape, color, size = 96 }: AvatarRenderInput): string {
  return renderBase(shapeDefinition(shape), {
    color: resolveColor(color),
    size: Math.max(MIN_SIZE, size),
    motion: "idle",
    time: 0,
    reducedMotion: true,
  });
}

/** Fails loudly at import time if a shape ever drifts from the library contract. */
export function assertShapeContract(ids: readonly string[]): void {
  for (const id of ids) {
    const result = validateAvatar(JSON.parse(JSON.stringify(shapeDefinition(id))));
    if (!result.ok) throw new Error(`avatar shape ${id} is invalid: ${result.errors.join("; ")}`);
  }
}
