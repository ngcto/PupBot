/** Shape ids are provisional until HOME-44 publishes `avatars.json`. */
export type AvatarShapeId = string;

export type AvatarColorId =
  | "chalk"
  | "sand"
  | "tomato"
  | "ember"
  | "amber"
  | "leaf"
  | "teal"
  | "sky"
  | "iris"
  | "bloom"
  | "slate";

/** The library's definition contract: one silhouette path in a 0 0 100 100 box. */
export interface AvatarDefinition {
  version: 1;
  id: string;
  name: string;
  body: { path: string };
  eyes: { x: number; y: number; spacing: number; scale: number };
}

export interface AvatarShape {
  id: AvatarShapeId;
  name: string;
  /** What the silhouette reads as, for the create dialog and docs. */
  note: string;
  definition: AvatarDefinition;
}

export interface AvatarColor {
  id: AvatarColorId;
  name: string;
  hex: string;
}

export interface AvatarRenderInput {
  shape: AvatarShapeId;
  /** A palette id or any `#rgb`/`#rrggbb` value. */
  color: AvatarColorId | string;
  size?: number;
}
