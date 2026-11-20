export type Shape =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; r?: number }
  | { kind: "polygon"; points: Array<[number, number]>; cornerRadius?: number };

export type EyeSlot = { x: number; y: number; w: number; h: number };

export type AvatarShapeId =
  | "circle"
  | "squircle"
  | "drop"
  | "cloud"
  | "hexa"
  | "gear"
  | "oval"
  | "triangle"
  | "shield"
  | "puff"
  | "pill"
  | "diamond"
  | "arch";

export type AvatarColorId =
  | "white"
  | "brown"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "aqua"
  | "teal"
  | "blue"
  | "purple"
  | "pink"
  | "grey"
  | "black";

/** Back-compat alias. */
export type AvatarColor = AvatarColorId;

export interface AvatarShape {
  id: AvatarShapeId;
  name: string;
  note?: string;
  eyeY: number;
  parts: Shape[];
}

export interface AvatarDefinition extends AvatarShape {
  eyes: [EyeSlot, EyeSlot];
}

export interface AvatarRenderInput {
  shape: AvatarShapeId | string;
  color: AvatarColorId | string;
  size?: number;
  title?: string;
  className?: string;
}
