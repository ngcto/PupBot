import { errorEventFromHttp, networkErrorEvent } from "./errors.ts";
import { joinUrl } from "./adapters/openai-chat.ts";
import type { ModelEndpointConfig } from "./types.ts";

/** One model id as the endpoint itself reports it. */
export interface ModelListing {
  id: string;
  ownedBy?: string;
  created?: number;
}

export interface ModelListingResult {
  models: ModelListing[];
  /** When the endpoint answered. */
  fetchedAt: string;
}

export class ModelListingError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code: string; status?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "ModelListingError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

const LIST_TIMEOUT_MS = 8_000;

function headersFor(endpoint: ModelEndpointConfig): Record<string, string> {
  if (endpoint.kind === "anthropic-messages") {
    return {
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      ...endpoint.headers,
      ...(endpoint.apiKey ? { "x-api-key": endpoint.apiKey } : {}),
    };
  }
  return {
    accept: "application/json",
    ...endpoint.headers,
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

/** Anthropic reports `display_name`/`created_at`; OpenAI-style reports `owned_by`/`created`. */
function normalise(payload: unknown): ModelListing[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const models: ModelListing[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) continue;
    const ownedBy =
      typeof record.owned_by === "string"
        ? record.owned_by
        : typeof record.owned_by === "undefined" && typeof record.type === "string"
          ? record.type
          : undefined;
    const createdRaw = record.created ?? record.created_at;
    const created =
      typeof createdRaw === "number"
        ? createdRaw
        : typeof createdRaw === "string" && Number.isFinite(Date.parse(createdRaw))
          ? Math.floor(Date.parse(createdRaw) / 1000)
          : undefined;
    models.push({ id, ...(ownedBy ? { ownedBy } : {}), ...(created !== undefined ? { created } : {}) });
  }
  return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

/**
 * `GET {baseUrl}/models` for the endpoint itself. This is the only way to know
 * what a BYO gateway actually serves — the models.dev snapshot can list ids the
 * endpoint never had, or miss the generation it has today.
 *
 * Throws `ModelListingError` with our codes; a 404/405 means the endpoint simply
 * has no listing (the caller falls back to the catalogue).
 */
export async function listEndpointModels(
  endpoint: ModelEndpointConfig,
  options: { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<ModelListingResult> {
  const timeout = options.timeoutMs ?? LIST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const call = options.fetch ?? fetch;
    const response = await call(joinUrl(endpoint.baseUrl, "models"), {
      method: "GET",
      headers: headersFor(endpoint),
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 404 || response.status === 405) {
        throw new ModelListingError("this endpoint does not list its models", {
          code: "no_model_listing",
          status: response.status,
        });
      }
      const mapped = errorEventFromHttp(response.status, body, response.headers);
      throw new ModelListingError(mapped.message, {
        code: mapped.code ?? "http_error",
        status: response.status,
        retryable: mapped.retryable,
      });
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    return { models: normalise(payload), fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof ModelListingError) throw error;
    if (signal.aborted) {
      throw new ModelListingError("the model list timed out", { code: "timeout" });
    }
    const mapped = networkErrorEvent(error);
    throw new ModelListingError(mapped.message, { code: mapped.code ?? "network_error" });
  } finally {
    clearTimeout(timer);
  }
}
