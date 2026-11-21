import { decryptSecret, modelCatalog as modelCatalogTable, modelEndpoint as modelEndpointTable } from "@terabot/db";
import type { Database } from "@terabot/db";
import {
  endpointConfigForRow,
  fillMissingDetails,
  providerHintForBaseUrl,
} from "@terabot/providers";
import type { DetailField, ModelDetails, ModelEndpointConfig } from "@terabot/providers";
import { and, eq } from "drizzle-orm";

type EndpointRow = typeof modelEndpointTable.$inferSelect;

/**
 * The fields the fill reads. Narrower than a full row so a not-yet-saved endpoint
 * can be filled before its insert, and so a test needs no database row shape.
 */
export type EndpointDetailSource = Pick<
  EndpointRow,
  "baseUrl" | "contextWindow" | "pricing" | "toolSupport" | "reasoningCapability" | "autoFilledFields"
>;

/** A row's own details, as the user set them or an earlier fill left them. */
export function detailsOf(endpoint: EndpointDetailSource): ModelDetails {
  return {
    contextWindow: endpoint.contextWindow,
    pricing: endpoint.pricing ?? null,
    toolSupport: endpoint.toolSupport ?? null,
    reasoning: endpoint.reasoningCapability ?? null,
  };
}

/** The stored provenance, narrowed to fields this build still knows. */
export function storedSources(endpoint: EndpointDetailSource): DetailField[] {
  return (endpoint.autoFilledFields ?? []) as DetailField[];
}

export interface EndpointConfigOptions {
  /** The conversation this request belongs to; built-ins that route per session need it. */
  session?: string;
  modelId?: string;
}

/**
 * Turns a stored endpoint row into the gateway config. The key is decrypted here,
 * so the UI's "Test connection" exercises the same path a run does, and a
 * built-in's URL and wire format come from the shared table rather than the row.
 */
export async function endpointConfigFor(
  db: Database,
  endpoint: EndpointRow,
  options: EndpointConfigOptions = {},
): Promise<ModelEndpointConfig> {
  void db;
  let apiKey: string | undefined;
  if (endpoint.encryptedKey) {
    try {
      apiKey = decryptSecret(endpoint.encryptedKey);
    } catch {
      apiKey = undefined;
    }
  }

  return endpointConfigForRow({
    kind: endpoint.kind,
    baseUrl: endpoint.baseUrl,
    builtinId: endpoint.builtinId,
    model: options.modelId ?? endpoint.modelId,
    ...(apiKey ? { apiKey } : {}),
    ...(options.session ? { session: options.session } : {}),
  });
}

export interface DetailsFill {
  /** The details after the fill, ready to write back. */
  details: ModelDetails;
  /** Every field in `details` that came from the catalogue, for `auto_filled_fields`. */
  sources: DetailField[];
}

/**
 * The gap-only fill for one endpoint's model: what the user set is left alone and
 * only an empty field is filled from models.dev. A field an earlier fill supplied
 * keeps its mark, so a price the catalogue gave stays badged on later visits.
 *
 * Returns null when the model is not in the catalogue at all, which is not a
 * failure: a BYO endpoint legitimately serves ids models.dev has never seen, and
 * the endpoint is then left exactly as it was.
 */
export async function fillEndpointDetails(
  db: Database,
  endpoint: EndpointDetailSource,
  modelId: string,
): Promise<DetailsFill | null> {
  const hint = providerHintForBaseUrl(endpoint.baseUrl);
  const [catalogue] = await db
    .select()
    .from(modelCatalogTable)
    .where(
      hint
        ? and(eq(modelCatalogTable.modelId, modelId), eq(modelCatalogTable.provider, hint))
        : eq(modelCatalogTable.modelId, modelId),
    )
    .limit(1);
  if (!catalogue) return null;

  const fill = fillMissingDetails(
    detailsOf(endpoint),
    {
      contextWindow: catalogue.contextWindow,
      pricing: catalogue.pricing ?? null,
      toolSupport: catalogue.toolSupport,
      reasoning: catalogue.reasoning,
    },
    storedSources(endpoint),
  );
  return { details: fill.details, sources: fill.sources };
}
