import { serverEnv } from "@terabot/config";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.ts";
import { newId } from "./ids.ts";
import { modelCatalog } from "./schema.ts";

export type ModelCatalogRow = typeof modelCatalog.$inferSelect;
export type CatalogRow = Omit<typeof modelCatalog.$inferInsert, "id" | "updatedAt">;
type CatalogDb = Pick<Database, "select" | "insert" | "transaction">;

const price = z.number().nonnegative();
const tokenLimit = z.number().int().nonnegative().max(2_147_483_647);

/**
 * Shape of https://models.dev/api.json as served today: an object keyed by
 * provider id, each provider carrying a `models` map keyed by model id.
 * Unknown keys pass through so `raw` keeps the full upstream object; the
 * fields we store are validated strictly, everything else is optional.
 */
export const modelsDevModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  modalities: z.looseObject({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.looseObject({ context: tokenLimit, output: tokenLimit }),
  cost: z
    .looseObject({
      input: price.optional(),
      output: price.optional(),
      cache_read: price.optional(),
      cache_write: price.optional(),
    })
    .optional(),
  tool_call: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  attachment: z.boolean().optional(),
  release_date: z.string().optional(),
});

export const modelsDevProviderSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.record(z.string(), modelsDevModelSchema),
});

export const modelsDevPayloadSchema = z.record(z.string(), modelsDevProviderSchema);

export type ModelsDevPayload = z.infer<typeof modelsDevPayloadSchema>;

export class CatalogSchemaError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `models.dev payload does not match the expected shape (${issues.length} problems):\n` +
        issues
          .slice(0, 10)
          .map((line) => `  ${line}`)
          .join("\n") +
        (issues.length > 10 ? `\n  ...and ${issues.length - 10} more` : ""),
    );
    this.name = "CatalogSchemaError";
  }
}

export function parseModelsDevPayload(payload: unknown): ModelsDevPayload {
  const parsed = modelsDevPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogSchemaError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const issues: string[] = [];
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) issues.push("(root): no providers");
  for (const [key, provider] of entries) {
    if (provider.id !== key) issues.push(`${key}.id: expected "${key}", got "${provider.id}"`);
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (model.id !== modelKey) issues.push(`${key}.models.${modelKey}.id: expected "${modelKey}", got "${model.id}"`);
    }
  }
  if (issues.length > 0) throw new CatalogSchemaError(issues);
  return parsed.data;
}

/**
 * Pure mapping from the models.dev payload to catalogue rows. Prices stay in
 * models.dev's unit (USD per 1M tokens). A limit of 0 means "not applicable"
 * upstream (image, embedding and audio models) and is stored as null.
 */
export function catalogRowsFrom(payload: unknown): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const { models, ...provider } of Object.values(parseModelsDevPayload(payload))) {
    for (const model of Object.values(models)) {
      const cost = model.cost;
      rows.push({
        provider: provider.id,
        modelId: model.id,
        name: model.name,
        contextWindow: model.limit.context || null,
        maxOutput: model.limit.output || null,
        pricing:
          cost && cost.input !== undefined
            ? {
                input: cost.input,
                ...(cost.output !== undefined && { output: cost.output }),
                ...(cost.cache_read !== undefined && { cacheRead: cost.cache_read }),
                ...(cost.cache_write !== undefined && { cacheWrite: cost.cache_write }),
              }
            : null,
        modalities: { input: model.modalities.input, output: model.modalities.output },
        toolSupport: model.tool_call ?? false,
        reasoning: model.reasoning ?? false,
        raw: { provider, model },
      });
    }
  }
  return rows;
}

const UPSERT_CHUNK = 500;

export async function syncModelCatalog(
  db: CatalogDb,
  options: { fetchImpl?: typeof fetch; url?: string } = {},
): Promise<{ total: number; upserted: number; providers: number }> {
  const url = options.url ?? serverEnv().MODELS_DEV_URL;
  const response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`models.dev responded ${response.status} ${response.statusText} for ${url}`);

  const payload = await response.json().catch(() => {
    throw new Error(`models.dev did not return JSON from ${url}`);
  });
  const rows = catalogRowsFrom(payload);
  const providers = new Set(rows.map((row) => row.provider)).size;

  const upserted = await db.transaction(async (tx) => {
    let written = 0;
    for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
      const result = await tx
        .insert(modelCatalog)
        .values(rows.slice(start, start + UPSERT_CHUNK).map((row) => ({ id: newId(), ...row })))
        .onConflictDoUpdate({
          target: [modelCatalog.provider, modelCatalog.modelId],
          set: {
            name: sql`excluded.name`,
            contextWindow: sql`excluded.context_window`,
            maxOutput: sql`excluded.max_output`,
            pricing: sql`excluded.pricing`,
            modalities: sql`excluded.modalities`,
            toolSupport: sql`excluded.tool_support`,
            reasoning: sql`excluded.reasoning`,
            raw: sql`excluded.raw`,
            updatedAt: sql`now()`,
          },
        });
      written += result.rowCount ?? 0;
    }
    return written;
  });

  return { total: rows.length, upserted, providers };
}

/**
 * Looks a model up in the catalogue. With a provider hint the exact
 * (provider, model) pair wins; otherwise, or when that pair is absent, any
 * provider carrying the model id matches, preferring one whose id is a prefix
 * of the hint (or the other way round), then rows with a known context window and pricing.
 * Never throws on a miss: the product warns and lets the user continue.
 */
export async function findCatalogMatch(
  db: CatalogDb,
  input: { modelId: string; providerHint?: string },
): Promise<{ row: ModelCatalogRow | null; match: "matched" | "unmatched" }> {
  const { modelId, providerHint } = input;

  if (providerHint) {
    const [exact] = await db
      .select()
      .from(modelCatalog)
      .where(and(eq(modelCatalog.provider, providerHint), eq(modelCatalog.modelId, modelId)))
      .limit(1);
    if (exact) return { row: exact, match: "matched" };
  }

  const candidates = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  const related = (row: ModelCatalogRow) =>
    providerHint !== undefined && (providerHint.startsWith(row.provider) || row.provider.startsWith(providerHint));
  candidates.sort(
    (a, b) =>
      Number(related(b)) - Number(related(a)) ||
      Number(b.contextWindow !== null) - Number(a.contextWindow !== null) ||
      Number(b.pricing !== null) - Number(a.pricing !== null) ||
      a.provider.localeCompare(b.provider),
  );

  const best = candidates[0];
  return best ? { row: best, match: "matched" } : { row: null, match: "unmatched" };
}
