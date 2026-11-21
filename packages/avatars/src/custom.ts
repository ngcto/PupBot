import type { AvatarDefinition } from "./types.ts";

/**
 * The four avatars we author ourselves, in open-bot-avatar's idiom: one closed
 * clockwise outline, a dominant mass that carries the face so the runtime eyes
 * keep their room, `version: 1`, and the definition's own eye placement.
 *
 * - `circle`: a true circle, r = 40 about (50, 50).
 * - `square`: 76 × 76 with an 18 corner radius, so the edges read rounded while
 *   the silhouette still reads square.
 * - `water-drop`: a point at (50, 10) widening into a 30-radius bowl at (50, 60);
 *   the eyes sit low, in the bowl.
 * - `heart`: cleft at (50, 27), two 22-radius lobes about (34, 42) and (66, 42),
 *   point at (50, 88).
 */
export const CUSTOM: readonly AvatarDefinition[] = [
  {
    version: 1,
    id: "circle",
    name: "Circle",
    body: {
      path: "M50 10C72.1 10 90 27.9 90 50C90 72.1 72.1 90 50 90C27.9 90 10 72.1 10 50C10 27.9 27.9 10 50 10Z",
    },
    eyes: { x: 50, y: 46, spacing: 16, scale: 1.1 },
  },
  {
    version: 1,
    id: "square",
    name: "Square",
    body: {
      path: "M30 12H70A18 18 0 0 1 88 30V70A18 18 0 0 1 70 88H30A18 18 0 0 1 12 70V30A18 18 0 0 1 30 12Z",
    },
    eyes: { x: 50, y: 46, spacing: 16, scale: 1.1 },
  },
  {
    version: 1,
    id: "water-drop",
    name: "Water drop",
    body: {
      path: "M50 10C50 10 80 40 80 60A30 30 0 0 1 50 90A30 30 0 0 1 20 60C20 40 50 10 50 10Z",
    },
    eyes: { x: 50, y: 56, spacing: 15, scale: 1.05 },
  },
  {
    version: 1,
    id: "heart",
    name: "Heart",
    body: {
      path: "M50 88C24 72 12 56 12 42A22 22 0 0 1 50 27A22 22 0 0 1 88 42C88 56 76 72 50 88Z",
    },
    eyes: { x: 50, y: 44, spacing: 15, scale: 1.05 },
  },
];
