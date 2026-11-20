export {
  COLORS,
  bubbleHex,
  colorById,
  colorHex,
  isColorId,
  resolveColor,
} from "./colors.ts";
export type { AvatarColorId, AvatarColor, AvatarColorSpec } from "./colors.ts";
export { deriveAccent, parseHex } from "./accent.ts";
export {
  AVATAR_SHAPES,
  SHAPES,
  SHAPE_IDS,
  isShapeId,
  shapeById,
  shapeDefinition,
} from "./shapes.ts";
export { renderAvatarSvg } from "./render.ts";
export type {
  AvatarDefinition,
  AvatarRenderInput,
  AvatarShape,
  AvatarShapeId,
  EyeSlot,
  Shape,
} from "./types.ts";

// Spec/consumer-friendly alias.
export { renderAvatarSvg as renderAvatar } from "./render.ts";
