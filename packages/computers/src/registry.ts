import { decryptSecret } from "@pupbot/db";
import { ProviderError } from "./contract.ts";
import type { ProviderFactory } from "./allocator/types.ts";
import { FakeComputerProvider } from "./fake.ts";
import { InstaboxProvider } from "./instabox/provider.ts";

export interface ProviderRegistryOptions {
  /** Template a new Instabox box starts from. */
  template?: string;
  /** Provider-side delete backstop. */
  ttlSeconds?: number;
  idleTimeoutSeconds?: number;
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
        throw new ProviderError("auth", `the Instabox key for ${account.label} cannot be decrypted: ${(error as Error).message}`, {
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

    if (account.provider === "boat") {
      throw new ProviderError("unavailable", "Boat is not implemented yet", { providerCode: "not_implemented" });
    }

    throw new ProviderError("unknown", `unknown computer provider ${account.provider}`);
  };
}
