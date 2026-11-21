import { decryptSecret } from "@terabot/db";
import { CredentialConfigError, ProviderError } from "./contract.ts";
import type { ProviderFactory } from "./allocator/types.ts";
import { Agent37Provider } from "./agent37/provider.ts";
import { FakeComputerProvider } from "./fake.ts";
import { InstaboxProvider } from "./instabox/provider.ts";

export interface ProviderRegistryOptions {
  /** Template a new Instabox box starts from. */
  template?: string;
  /** Provider-side delete backstop. */
  ttlSeconds?: number;
  idleTimeoutSeconds?: number;
  /** Template a new Agent37 instance starts from; `agent37-hermes` by default. */
  agent37Template?: string;
  /** Where a new Agent37 instance runs: us, eu or ap-south. Fixed for its life. */
  agent37Region?: "us" | "eu" | "ap-south";
  /**
   * Let Agent37 itself sleep an idle instance. Off by default so the
   * allocator's idle sweep stays the single authority over sleep, as it is for
   * Instabox.
   */
  agent37AutoSleep?: boolean;
}

/**
 * Builds the provider behind an account row. Credentials are decrypted here and
 * nowhere else; a bad key becomes an `auth` error the allocator can drain an
 * account for, not an exception that stops the whole pool.
 */
export function createProviderFactory(options: ProviderRegistryOptions = {}): ProviderFactory {
  // The fake keeps boxes in this process' memory, and the web app and the
  // worker are separate processes, so it adopts the ids the other one made.
  const fakes = new Map<string, FakeComputerProvider>();

  return (account) => {
    if (account.provider === "fake") {
      const existing = fakes.get(account.id);
      if (existing) return existing;
      const provider = new FakeComputerProvider({ account: account.id, adoptUnknownIds: true });
      fakes.set(account.id, provider);
      return provider;
    }

    if (account.provider === "instabox") {
      let apiKey: string;
      try {
        apiKey = decryptSecret(account.encryptedCredential);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A missing or wrong-length CREDENTIAL_ENCRYPTION_KEY fails the same way
        // for every account. Treat the deployment as misconfigured, not each
        // credential as revoked, so the pool does not drain itself to `error`.
        if (/CREDENTIAL_ENCRYPTION_KEY/.test(message)) {
          throw new CredentialConfigError(`the Instabox key for ${account.label} cannot be decrypted: ${message}`);
        }
        throw new ProviderError("auth", `the Instabox key for ${account.label} cannot be decrypted: ${message}`, {
          providerCode: "bad_credential",
        });
      }
      return new InstaboxProvider({
        account: account.id,
        apiKey,
        template: options.template,
        ttlSeconds: options.ttlSeconds,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
      });
    }

    if (account.provider === "agent37") {
      let apiKey: string;
      try {
        apiKey = decryptSecret(account.encryptedCredential);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/CREDENTIAL_ENCRYPTION_KEY/.test(message)) {
          throw new CredentialConfigError(`the Agent37 key for ${account.label} cannot be decrypted: ${message}`);
        }
        throw new ProviderError("auth", `the Agent37 key for ${account.label} cannot be decrypted: ${message}`, {
          providerCode: "bad_credential",
        });
      }
      return new Agent37Provider({
        account: account.id,
        apiKey,
        template: options.agent37Template,
        region: options.agent37Region,
        autoSleep: options.agent37AutoSleep,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
      });
    }

    if (account.provider === "boat") {
      throw new ProviderError("unavailable", "Boat is not implemented yet", { providerCode: "not_implemented" });
    }

    throw new ProviderError("unknown", `unknown computer provider ${account.provider}`);
  };
}
