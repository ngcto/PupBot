import { decryptSecret, modelEndpoint as modelEndpointTable } from "@terabot/db";
import type { Database } from "@terabot/db";
import type { ModelEndpointConfig } from "@terabot/providers";
import { eq } from "drizzle-orm";

type EndpointRow = typeof modelEndpointTable.$inferSelect;

/**
 * Turns a stored endpoint row into the gateway config. The key is decrypted here,
 * so the UI's "Test connection" exercises the same path a run does.
 */
export async function endpointConfigFor(
  db: Database,
  endpoint: EndpointRow,
  modelId?: string,
): Promise<ModelEndpointConfig> {
  let apiKey: string | undefined;
  if (endpoint.encryptedKey) {
    try {
      apiKey = decryptSecret(endpoint.encryptedKey);
    } catch {
      apiKey = undefined;
    }
  }

  // The stored key is the only credential kind left; a row without one is
  // reported by the caller as a broken endpoint, here.
  void eq;
  void db;
  return {
    kind: endpoint.kind,
    baseUrl: endpoint.baseUrl,
    model: modelId ?? endpoint.modelId,
    ...(apiKey ? { apiKey } : {}),
  };
}
