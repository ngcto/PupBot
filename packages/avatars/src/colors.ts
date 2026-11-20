import type { AvatarColorId } from "./types.ts";
export type { AvatarColorId, AvatarColor } from "./types.ts";

export type AvatarColorSpec = {
  id: AvatarColorId;
  name: string;
  hex: string;
  /** Canonical bubble colour for user messages in this colour's accent. */
  bubble: string;
};

export const COLORS: readonly AvatarColorSpec[] = [
  { id: "white", name: "White", hex: "#ffffff", bubble: "#cfcfcf" },
  { id: "brown", name: "Brown", hex: "#a16b39", bubble: "#865b32" },
  { id: "red", name: "Red", hex: "#fc2c3e", bubble: "#cf2b35" },
  { id: "orange", name: "Orange", hex: "#f9670e", bubble: "#ce570e" },
  { id: "yellow", name: "Yellow", hex: "#f69412", bubble: "#c8780e" },
  { id: "green", name: "Green", hex: "#16a04f", bubble: "#14843f" },
  { id: "aqua", name: "Aqua", hex: "#0daabd", bubble: "#0d8c99" },
  { id: "teal", name: "Teal", hex: "#1aa7a9", bubble: "#178a8a" },
  { id: "blue", name: "Blue", hex: "#1884fc", bubble: "#136ed2" },
  { id: "purple", name: "Purple", hex: "#5c6cf9", bubble: "#4b59d8" },
  { id: "pink", name: "Pink", hex: "#fa6b92", bubble: "#d65979" },
  { id: "grey", name: "Grey", hex: "#7a7a7a", bubble: "#676767" },
  { id: "black", name: "Black", hex: "#333333", bubble: "#303030" },
] as const;

const byId = new Map(COLORS.map((color) => [color.id, color]));

export function isColorId(id: string): id is AvatarColorId {
  return byId.has(id as AvatarColorId);
}

export function colorById(id: AvatarColorId): AvatarColorSpec {
  return byId.get(id)!;
}

export function colorHex(color: AvatarColorId | string): string {
  return byId.get(color as AvatarColorId)?.hex ?? color;
}

/** Canonical palette ids resolve to their hex; any other string is treated as a CSS colour. */
export function resolveColor(color: AvatarColorId | string): string {
  return colorHex(color);
}

export function bubbleHex(color: AvatarColorId): string {
  return colorById(color).bubble;
}
