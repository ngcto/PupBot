import { examples } from "open-bot-avatar";
import { GALLERY } from "./gallery/index.ts";
import type { AvatarDefinition, AvatarShape } from "./types.ts";

/**
 * The registry is `open-bot-avatar`'s own avatar set: the 16 gallery definitions
 * vendored as data (see `gallery/NOTICE.md`) followed by the 7 starter avatars
 * imported from the package, so a package upgrade brings their shapes as it does
 * its renderer. No silhouette path lives in this file.
 *
 * Ids, in this order, are API: `book`, `brain`, `bull`, `bunny`, `camera`, `cat`,
 * `cloud`, `egg`, `ghost`, `magnifier`, `paint-brush`, `palette`, `rocket`,
 * `shield`, `star`, `witch-hat`, then `controller`, `barbell`, `mug`, `lightbulb`,
 * `chat`, `sprout`, `watering-can`. A stored avatar naming anything else — a
 * retired id from our earlier families, or anything we never shipped — renders
 * the first entry.
 *
 * Eyes come with each definition: `open-bot-avatar` places the pair per object,
 * and we do not override the geometry, the depth or the ink.
 */
const NOTES: Record<string, string> = {
  book: "An open book",
  brain: "Side view, a folded brain",
  bull: "Front view with horns",
  bunny: "Long ears and a round face",
  camera: "A camera with a lens",
  cat: "Pointed ears and whiskers",
  cloud: "A soft cloud",
  egg: "A standing egg",
  ghost: "A ghost with a wavy hem",
  magnifier: "A magnifying glass",
  "paint-brush": "A loaded paint brush",
  palette: "A painter's palette",
  rocket: "A rocket with fins",
  shield: "A shield",
  star: "A five-pointed star",
  "witch-hat": "A pointed witch hat",
  controller: "Front view, face above the grips",
  barbell: "Side view, a bar with round plates",
  mug: "Side view, a cup with a handle loop",
  lightbulb: "Front view, a globe on a stepped base",
  chat: "Speech bubble with a tail",
  sprout: "A pot with a stem and two leaves",
  "watering-can": "Side view, a can with a handle and spout",
};

const DEFINITIONS: readonly AvatarDefinition[] = [...GALLERY, ...examples];

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
