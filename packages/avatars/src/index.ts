export { SHAPES, SHAPE_IDS, DEFAULT_SHAPE, isShapeId, shapeById, shapeDefinition } from "./shapes.ts";
export { COLORS, DEFAULT_COLOR, colorHex, isColorId, resolveColor } from "./colors.ts";
export { deriveAccent, parseHex, srgbToOklch, oklchToHex } from "./accent.ts";
export { GLYPH_LEAN_DEG, renderAvatarSvg } from "./render.ts";
export { bodyBounds, eyeCapsules, eyeMarkup } from "./eyes.ts";
export type { EyeCapsule } from "./eyes.ts";
export { EYE_FIT, EYE_LAYOUT } from "./eye-fit.ts";
export type {
  AvatarColor,
  AvatarColorId,
  AvatarDefinition,
  AvatarRenderInput,
  AvatarShape,
  AvatarShapeId,
} from "./types.ts";
