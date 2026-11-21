import { z } from "zod";

const url = z.string().url();
const optionalUrl = z.string().url().optional().or(z.literal("")).transform((v) => (v ? v : undefined));
const optionalSecret = z.string().min(1).optional().or(z.literal("")).transform((v) => (v ? v : undefined));

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: url.default("http://localhost:3000"),
  API_URL: url.default("http://localhost:8787"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  /**
   * Where a run executes. `queue` hands the run to the pg-boss worker;
   * `inline` runs it inside the API request on a long-lived function.
   */
  RUN_MODE: z.enum(["queue", "inline"]).default("queue"),
  /** Postgres pool ceiling per process. Serverless needs this to stay small. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  STUB_PROVIDER: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CREDENTIAL_ENCRYPTION_KEY: optionalSecret,
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET: optionalSecret,
  S3_ACCESS_KEY: optionalSecret,
  S3_SECRET_KEY: optionalSecret,
  INSTABOX_API_KEY: optionalSecret,
  BOAT_API_KEY: optionalSecret,
  COMPOSIO_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  MODELS_DEV_URL: url.default("https://models.dev/api.json"),
  // Vercel AI Gateway: OpenAI-compatible, keyless on a Vercel deployment
  // because the deployment's OIDC token authenticates each request.
  AI_GATEWAY_BASE_URL: url.default("https://ai-gateway.vercel.sh/v1"),
  AI_GATEWAY_MODEL: z.string().min(1).default("openai/gpt-5.4-mini"),
  AI_GATEWAY_API_KEY: optionalSecret,
  /** Injected by Vercel at runtime; auto-refreshed, never committed. */
  VERCEL_OIDC_TOKEN: optionalSecret,
  /** Marks a Vercel deployment, so OIDC is known to be available. */
  VERCEL: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${detail}\n\nCopy .env.example to .env and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * AI Gateway needs a credential: the deployment's OIDC token on Vercel, or an
 * explicit key elsewhere. Without one we never hand out a gateway endpoint,
 * because a keyless request would fail at the first message instead of at
 * setup time.
 *
 * A Vercel deployment gets its token per request in the `x-vercel-oidc-token`
 * header, not the environment, and rotates it about every hour — so it is read
 * on each request rather than cached with the rest of the environment.
 */
let requestOidcToken: string | undefined;

/** Called by the serverless entry point with the token of the current request. */
export function setRequestOidcToken(token: string | null | undefined): void {
  requestOidcToken = token ?? undefined;
}

export async function gatewayCredential(env: ServerEnv = serverEnv()): Promise<string | undefined> {
  if (env.AI_GATEWAY_API_KEY) return env.AI_GATEWAY_API_KEY;
  if (requestOidcToken) return requestOidcToken;
  if (env.VERCEL_OIDC_TOKEN) return env.VERCEL_OIDC_TOKEN;
  if (!env.VERCEL) return undefined;
  const { getVercelOidcToken } = await import("@vercel/oidc");
  try {
    return await getVercelOidcToken();
  } catch {
    return undefined;
  }
}

export function isGatewayAvailable(env: ServerEnv = serverEnv()): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY ?? env.VERCEL_OIDC_TOKEN) || Boolean(env.VERCEL);
}

export function isStubProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return serverEnv(env).STUB_PROVIDER && serverEnv(env).NODE_ENV !== "production";
}

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: url.default("http://localhost:8787"),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function publicEnv(source: NodeJS.ProcessEnv = process.env): PublicEnv {
  const parsed = publicEnvSchema.safeParse(source);
  if (!parsed.success) throw new Error(`Invalid public environment: ${parsed.error.message}`);
  return parsed.data;
}
