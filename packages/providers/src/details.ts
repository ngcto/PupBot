/**
 * Model details a user can set by hand, and the ones the models.dev catalogue
 * can supply. Every field is optional: an absent field means "not known", which
 * is exactly the state auto-population is allowed to fill.
 */
export interface ModelDetails {
  /** Total prompt window in tokens. */
  contextWindow?: number | null;
  /** USD per 1M tokens, as models.dev states it. */
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
  /** Whether the model accepts tool calls. */
  toolSupport?: boolean | null;
  /** Whether the model reasons before it answers. */
  reasoning?: boolean | null;
}

export const DETAIL_FIELDS = ["contextWindow", "pricing", "toolSupport", "reasoning"] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

export interface DetailFill {
  /** The merged details; a field the caller had set is untouched. */
  details: ModelDetails;
  /** Fields this call took from the catalogue, so the UI can say where they came from. */
  autoFilled: DetailField[];
  /**
   * Every field in `details` that came from the catalogue, this call or an
   * earlier one — what to store beside the details so a filled number stays
   * badged after the fill, not only in the moment it happened.
   */
  sources: DetailField[];
}

function usableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function usablePricing(value: unknown): value is NonNullable<ModelDetails["pricing"]> {
  if (!value || typeof value !== "object") return false;
  // A price of 0 is real (a free model); only an object with no numeric rate at
  // all is "not set".
  return Object.values(value as Record<string, unknown>).some(
    (rate) => typeof rate === "number" && Number.isFinite(rate),
  );
}

/**
 * Whether a field already carries a value the user meant. A number of 0 or a
 * negative is not a usable window, and neither is a null, so those count as
 * unset and may be filled. Booleans are different: `false` is a real answer
 * ("this model does not call tools"), so only `null`/`undefined` is unset.
 */
export function isSet(field: DetailField, value: unknown): boolean {
  switch (field) {
    case "contextWindow":
      return usableNumber(value);
    case "pricing":
      return usablePricing(value);
    case "toolSupport":
    case "reasoning":
      return typeof value === "boolean";
  }
}

/**
 * Fills the details a user has not set from the catalogue, and never touches one
 * they have. The rule matters because the catalogue is a guess at what a BYO
 * gateway serves: a user who typed this model's real 32k window must not have it
 * replaced with models.dev's 200k for a similarly named model, and a user who
 * turned tool calls off must not have them turned back on.
 *
 * A field is only filled when the catalogue actually has a usable value for it,
 * so an unmatched model leaves the endpoint exactly as it was.
 *
 * `previousSources` is what an earlier fill reported for this row, so a price
 * that came from the catalogue stays badged on a later visit. This function
 * cannot tell an untouched filled value from one the user later retyped — both
 * are simply "set" — so a write path that accepts a user's own edit clears the
 * mark for the fields they touched with `sourcesAfterUserEdit`.
 */
export function fillMissingDetails(
  current: ModelDetails | null | undefined,
  catalogue: ModelDetails | null | undefined,
  previousSources: readonly DetailField[] = [],
): DetailFill {
  const details: ModelDetails = { ...(current ?? {}) };
  const autoFilled: DetailField[] = [];
  if (!catalogue) return { details, autoFilled, sources: [] };

  for (const field of DETAIL_FIELDS) {
    if (isSet(field, details[field])) continue;
    const candidate = catalogue[field];
    if (!isSet(field, candidate)) continue;
    // `isSet` has already narrowed the type for every field above.
    (details as Record<DetailField, unknown>)[field] = candidate;
    autoFilled.push(field);
  }

  const sources = DETAIL_FIELDS.filter(
    (field) =>
      isSet(field, details[field]) && (autoFilled.includes(field) || previousSources.includes(field)),
  );
  return { details, autoFilled, sources };
}

/**
 * The provenance list after the user edits some fields by hand: every field they
 * touched stops being catalogue-sourced, because the number is now theirs.
 */
export function sourcesAfterUserEdit(
  sources: readonly DetailField[] | null | undefined,
  edited: readonly DetailField[],
): DetailField[] {
  return (sources ?? []).filter(
    (field) => !edited.includes(field) && (DETAIL_FIELDS as readonly string[]).includes(field),
  );
}
