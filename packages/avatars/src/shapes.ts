import { getExample } from "open-bot-avatar";
import { GALLERY } from "./gallery/index.ts";
import type { AvatarDefinition, AvatarShape } from "./types.ts";

/**
 * The registry is `open-bot-avatar`'s avatars, nothing of ours: five of its starter
 * avatars taken straight from the package with `getExample`, and nine of its
 * gallery avatars vendored as data (see `gallery/NOTICE.md`). No silhouette is
 * copied into this file and we author none.
 *
 * Ids, in this order, are API: `mug`, `lightbulb`, `chat`, `sprout`,
 * `watering-can`, then `bull`, `bunny`, `camera`, `cat`, `cloud`, `ghost`,
 * `rocket`, `star`, `witch-hat`.
 *
 * A stored avatar naming anything else — a retired id from our earlier families,
 * the traced Grok Bot set, or a starter or gallery avatar we do not ship —
 * renders `mug`.
 *
 * Eyes come with each definition and we do not override the geometry, the depth
 * or the ink.
 */
const STARTER_IDS = ["mug", "lightbulb", "chat", "sprout", "watering-can"] as const;

const NOTES: Record<string, string> = {
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
};

const DEFINITIONS: readonly AvatarDefinition[] = [
  ...STARTER_IDS.map((id) => {
    const definition = getExample(id);
    if (!definition) throw new Error(`open-bot-avatar no longer ships the ${id} starter avatar`);
    return definition;
  }),
  ...GALLERY,
];

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
