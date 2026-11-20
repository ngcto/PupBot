/**
 * The step row's label. The reference generates verb phrases ("Mulling it
 * over", "Checking GitHub releases"); without tools we rotate a small set so
 * the row is never a spinner that looks stuck.
 */
const PRE_TOKEN_LABELS = ["Mulling it over", "Thinking it through", "Putting it together"];

export function stepLabel(index: number): string {
  return PRE_TOKEN_LABELS[Math.min(index, PRE_TOKEN_LABELS.length - 1)] ?? PRE_TOKEN_LABELS[0]!;
}

export const STEP_ROTATE_MS = 1800;
