interface HostHint {
  /** Hostname suffixes that belong to this provider. */
  hosts: string[];
  provider: string;
}

const HOST_HINTS: readonly HostHint[] = [
  { hosts: ["openrouter.ai"], provider: "openrouter" },
  { hosts: ["agentrouter.org"], provider: "agentrouter" },
  { hosts: ["anthropic.com", "claude.ai"], provider: "anthropic" },
  { hosts: ["openai.com", "openai.azure.com", "azure.com"], provider: "openai" },
  { hosts: ["groq.com"], provider: "groq" },
  { hosts: ["googleapis.com", "google.dev"], provider: "google" },
  { hosts: ["mistral.ai"], provider: "mistral" },
  { hosts: ["deepseek.com"], provider: "deepseek" },
  { hosts: ["x.ai"], provider: "xai" },
  { hosts: ["fireworks.ai"], provider: "fireworks" },
  { hosts: ["together.ai", "together.xyz"], provider: "togetherai" },
];

/**
 * Best-effort catalogue provider for a BYO base URL, used to disambiguate a
 * model id that several providers publish (models.dev keys by provider).
 *
 * Matching is on whole hostname labels: `openai.example` and
 * `openrouter.attacker.example` must not read as OpenAI or OpenRouter.
 */
export function providerHintForBaseUrl(baseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  return HOST_HINTS.find((hint) =>
    hint.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)),
  )?.provider;
}
