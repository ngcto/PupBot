import type { AvatarColor, AvatarColorId } from "./types.ts";

export const COLORS: readonly AvatarColor[] = [
  { id: "chalk", name: "Chalk", hex: "#ffffff" },
  { id: "sand", name: "Sand", hex: "#a16b39" },
  { id: "tomato", name: "Tomato", hex: "#fc2c3e" },
  { id: "ember", name: "Ember", hex: "#f9670e" },
  { id: "amber", name: "Amber", hex: "#f69412" },
  { id: "leaf", name: "Leaf", hex: "#14c370" },
  { id: "teal", name: "Teal", hex: "#13b8a3" },
  { id: "sky", name: "Sky", hex: "#1884fc" },
  { id: "iris", name: "Iris", hex: "#905afb" },
  { id: "bloom", name: "Bloom", hex: "#fb3499" },
  { id: "slate", name: "Slate", hex: "#777777" },
] as const;

/** The package's own starter orange is `#ff6a1a`; `ember` is the palette's nearest entry. */
export const DEFAULT_COLOR: AvatarColorId = "ember";

const byId = new Map(COLORS.map((color) => [color.id, color]));

export function isColorId(value: string): value is AvatarColorId {
  return byId.has(value as AvatarColorId);
}

export function colorHex(id: AvatarColorId): string {
  const color = byId.get(id);
  if (!color) throw new Error(`unknown avatar colour: ${id}`);
  return color.hex;
}

/** Palette ids resolve to their hex; any other string is treated as a CSS colour. */
export function resolveColor(color: AvatarColorId | string): string {
  return byId.get(color as AvatarColorId)?.hex ?? color;
}
