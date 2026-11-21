import { examples } from "open-bot-avatar";
import { CUSTOM } from "./custom.ts";
import { GALLERY } from "./gallery/index.ts";
import type { AvatarDefinition, AvatarShape } from "./types.ts";

/**
 * The registry is `open-bot-avatar`'s avatar set plus four we author ourselves:
 * its 7 starter avatars imported from the package (so a package upgrade brings
 * their shapes), 9 gallery avatars vendored as data (see `gallery/NOTICE.md`),
 * and our own `circle`, `square`, `water-drop` and `heart` (see `custom.ts`).
 * No vendored or package silhouette is copied into this file.
 *
 * Ids, in this order, are API:
 * `controller`, `barbell`, `mug`, `lightbulb`, `chat`, `sprout`, `watering-can`,
 * `bull`, `bunny`, `camera`, `cat`, `cloud`, `ghost`, `rocket`, `star`,
 * `witch-hat`, `circle`, `square`, `water-drop`, `heart`.
 *
 * A stored avatar naming anything else — a retired id from our earlier families,
 * the traced Grok Bot set, or a gallery avatar we cut — renders the first entry.
 *
 * Eyes come with each definition and we do not override the geometry, the depth
 * or the ink.
 */
const NOTES: Record<string, string> = {
  controller: "Front view, face above the grips",
  barbell: "Side view, a bar with round plates",
  mug: "Side view, a cup with a handle loop",
  lightbulb: "Front view, a globe on a stepped base",
  chat: "Speech bubble with a tail",
  sprout: "A pot with a stem and two leaves",
  "watering-can": "Side view, a can with a handle and spout",
  bull: "Front view with horns",
  bunny: "Long ears and a round face",
  camera: "A camera with a lens",
  cat: "Pointed ears and whiskers",
  cloud: "A soft cloud",
  ghost: "A ghost with a wavy hem",
  rocket: "A rocket with fins",
  star: "A five-pointed star",
  "witch-hat": "A pointed witch hat",
  circle: "A true circle",
  square: "A square with rounded edges",
  "water-drop": "A drop with the eyes in the bowl",
  heart: "A heart with a cleft",
};

const DEFINITIONS: readonly AvatarDefinition[] = [...examples, ...GALLERY, ...CUSTOM];

export const SHAPES: readonly AvatarShape[] = DEFINITIONS.map((definition) => ({
  id: definition.id,
  name: definition.name,
  note: NOTES[definition.id] ?? "",
  definition,
}));

export const SHAPE_IDS = SHAPES.map((shape) => shape.id);

/** The first id in the registry; a stored avatar that names no known shape renders it. */
export const DEFAULT_SHAPE: string = SHAPE_IDS[0]!;

const byId = new Map(SHAPES.map((shape) => [shape.id, shape]));
const fallback = SHAPES[0]!.definition;

export function isShapeId(value: string): boolean {
  return byId.has(value);
}

export function shapeDefinition(id: string): AvatarDefinition {
  return byId.get(id)?.definition ?? fallback;
}

export function shapeById(id: string): AvatarShape {
  return byId.get(id) ?? SHAPES[0]!;
}
