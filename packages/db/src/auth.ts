import { serverEnv } from "@pupbot/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { database } from "./client.ts";
import { newId } from "./ids.ts";
import { account, schema, session, user, verification } from "./schema.ts";

export type Auth = ReturnType<typeof createAuth>;

export function createAuth() {
  const env = serverEnv();
  return betterAuth({
    appName: "PupBot",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL, env.API_URL],
    database: drizzleAdapter(database(), {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      database: { generateId: () => newId() },
      cookiePrefix: "pupbot",
    },
  });
}

let cached: Auth | undefined;

export function auth(): Auth {
  if (!cached) cached = createAuth();
  return cached;
}

export { schema };
