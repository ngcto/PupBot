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
  /** How many boxes the Instabox account's plan allows (free: 1, grandfathered accounts: 5). */
  INSTABOX_CAPACITY: z.coerce.number().int().positive().default(1),
  BOAT_API_KEY: optionalSecret,
  COMPOSIO_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  MODELS_DEV_URL: url.default("https://models.dev/api.json"),
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
