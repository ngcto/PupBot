import { z } from "zod";

/**
 * The marketing site has no runtime secrets. Two public origins are all it
 * needs: where the site itself lives (canonical URLs, OG tags) and where the
 * product lives (sign-in). Both have development defaults so a clean clone
 * builds; a deploy sets the real ones.
 */
const schema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

const parsed = schema.safeParse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

if (!parsed.success) {
  const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid marketing environment:\n${detail}`);
}

export const marketingEnv = parsed.data;
