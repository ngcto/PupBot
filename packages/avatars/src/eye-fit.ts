/**
 * The numbers the eye layer draws from. Everything here was measured off Ng's Grok
 * Bot reference and then fitted against our own 14 glyphs, in units of each glyph's
 * inscribed radius `R` (half its narrower drawn extent).
 */

/**
 * The pair in the reference, capsule by capsule: `cx`/`cy` are its centre's offset
 * from the pair's own midpoint, `length` and `width` its long and short axes, and
 * `angle` the long axis in degrees below horizontal (so both capsules run from
 * upper-left to lower-right). The near eye is the fat low one, the far eye the thin
 * high one; that asymmetry is what makes the pair read as looking up and to the
 * right, and it is why nothing has to rotate.
 */
export const EYE_LAYOUT = {
  pairOffset: { x: 0.52, y: 0.06 },
  near: { cx: -0.21, cy: 0.05, length: 0.52, width: 0.27, angle: 60 },
  far: { cx: 0.21, cy: -0.05, length: 0.5, width: 0.21, angle: 60 },
};

/**
 * Where a glyph's pair has to be moved to stay inside its own body, in units of
 * `R`: a smaller `scale`, or `dx`/`dy` shifting it. A glyph appears here only when
 * the shared layout does not fit its upper right as drawn. Each entry was fitted by
 * rendering the glyph at 256 px and requiring no eye ink to leave the silhouette.
 */
export const EYE_FIT: Record<string, { scale: number; dx?: number; dy?: number }> = {
  rocket: { scale: 1, dx: -0.18 },
  star: { scale: 1, dx: -0.06 },
  "witch-hat": { scale: 1, dx: -0.12 },
};
