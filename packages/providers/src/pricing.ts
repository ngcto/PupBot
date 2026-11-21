export interface ModelPricing {
  /** USD per 1,000,000 tokens, as models.dev states it. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TokenUsage {
  /** Prompt tokens that are not served from or written to the prompt cache. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * USD for one call. Returns null when the catalogue has no price for the model,
 * so a missing price stays visibly unknown instead of reading as free.
 *
 * Cache tokens are priced from `cacheRead`/`cacheWrite` when the catalogue lists
 * them, and fall back to the ordinary input rate otherwise.
 */
export function costOf(pricing: ModelPricing | null | undefined, usage: TokenUsage): number | null {
  if (!pricing) return null;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return null;
  if (inputTokens + cacheReadTokens + cacheWriteTokens > 0 && pricing.input === undefined) return null;
  if (outputTokens > 0 && pricing.output === undefined) return null;

  const inputRate = pricing.input ?? 0;
  const outputRate = pricing.output ?? 0;
  const cacheReadRate = pricing.cacheRead ?? inputRate;
  const cacheWriteRate = pricing.cacheWrite ?? inputRate;

  const total =
    inputTokens * inputRate +
    cacheReadTokens * cacheReadRate +
    cacheWriteTokens * cacheWriteRate +
    outputTokens * outputRate;
  return total / 1_000_000;
}

/** Fixed-precision decimal for a `numeric` column, or null when unknown. */
export function costAsDecimal(cost: number | null): string | null {
  return cost === null ? null : cost.toFixed(6);
}

export function formatUsd(cost: number | null): string {
  if (cost === null) return "unknown";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
