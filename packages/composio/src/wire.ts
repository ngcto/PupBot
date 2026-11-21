import { z } from "zod";
import { supportFor } from "./types.ts";
import type { AuthConfig, Connection, ConnectionLink, ToolkitSummary } from "./types.ts";
import { connectionStateFrom } from "./types.ts";

/**
 * Composio Platform REST v3.1 wire shapes, read live against the project key
 * and checked against docs.composio.dev/reference (v3.1 is the current version,
 * v3.0 remains supported). Unknown fields are dropped, so an additive change on
 * their side does not break a page.
 */

const categorySchema = z.object({ id: z.string().optional(), name: z.string() });

export const toolkitWireSchema = z.object({
  slug: z.string(),
  name: z.string(),
  auth_schemes: z.array(z.string()).nullish(),
  composio_managed_auth_schemes: z.array(z.string()).nullish(),
  // The endpoint documents this as required but older rows omit it.
  deprecated: z.object({ toolkitId: z.string().optional() }).nullish(),
  meta: z
    .object({
      description: z.string().nullish(),
      logo: z.string().nullish(),
      app_url: z.string().nullish(),
      categories: z.array(categorySchema).nullish(),
      tools_count: z.number().nullish(),
    })
    .nullish(),
});

export type ToolkitWire = z.infer<typeof toolkitWireSchema>;

export const toolkitListSchema = z.object({
  items: z.array(toolkitWireSchema),
  next_cursor: z.string().nullish(),
});

export const authConfigWireSchema = z.object({
  id: z.string(),
  auth_scheme: z.string(),
  is_composio_managed: z.boolean().nullish(),
  toolkit: z.object({ slug: z.string() }).nullish(),
});

export const authConfigListSchema = z.object({
  items: z.array(authConfigWireSchema),
  next_cursor: z.string().nullish(),
});

/** Answer to POST /auth_configs: the new config, nested under `auth_config`. */
export const createdAuthConfigSchema = z.object({
  toolkit: z.object({ slug: z.string() }).nullish(),
  auth_config: z.object({
    id: z.string(),
    auth_scheme: z.string().nullish(),
    is_composio_managed: z.boolean().nullish(),
  }),
});

export const connectionWireSchema = z.object({
  id: z.string(),
  status: z.string().nullish(),
  alias: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  toolkit: z.object({ slug: z.string() }).nullish(),
  auth_config: z.object({ id: z.string() }).nullish(),
  // Some responses only carry the status nested here.
  state: z.object({ val: z.object({ status: z.string().nullish() }).nullish() }).nullish(),
});

export type ConnectionWire = z.infer<typeof connectionWireSchema>;

export const connectionListSchema = z.object({
  items: z.array(connectionWireSchema),
  next_cursor: z.string().nullish(),
});

export const linkSchema = z.object({
  connected_account_id: z.string(),
  redirect_url: z.string(),
  expires_at: z.string(),
});

const apiErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      slug: z.string().optional(),
      suggested_fix: z.string().optional(),
    })
    .optional(),
});

export function toolkitFromWire(wire: ToolkitWire): ToolkitSummary {
  const authSchemes = (wire.auth_schemes ?? []).filter(Boolean);
  const managedAuthSchemes = (wire.composio_managed_auth_schemes ?? []).filter(Boolean);
  const categories = (wire.meta?.categories ?? []).map((entry) => entry.name).filter(Boolean);

  return {
    slug: wire.slug,
    name: wire.name,
    description: wire.meta?.description ?? "",
    logoUrl: wire.meta?.logo ?? "",
    appUrl: wire.meta?.app_url ?? null,
    categories: [...new Set(categories)],
    authSchemes,
    managedAuthSchemes,
    toolsCount: wire.meta?.tools_count ?? 0,
    support: supportFor({ authSchemes, managedAuthSchemes }),
  };
}

export function authConfigFromWire(wire: z.infer<typeof authConfigWireSchema>): AuthConfig {
  const managed = Boolean(wire.is_composio_managed);
  return {
    id: wire.id,
    toolkit: wire.toolkit?.slug ?? "",
    scheme: wire.auth_scheme,
    managed,
    userSupplied: !managed,
  };
}

export function connectionFromWire(wire: ConnectionWire): Connection {
  const rawStatus = wire.status ?? wire.state?.val?.status ?? "";
  return {
    id: wire.id,
    toolkit: wire.toolkit?.slug ?? "",
    authConfigId: wire.auth_config?.id ?? "",
    alias: wire.alias ?? null,
    rawStatus,
    state: connectionStateFrom(rawStatus),
    createdAt: wire.created_at ?? null,
    updatedAt: wire.updated_at ?? null,
  };
}

export function linkFromWire(wire: z.infer<typeof linkSchema>): ConnectionLink {
  return {
    connectedAccountId: wire.connected_account_id,
    redirectUrl: wire.redirect_url,
    expiresAt: wire.expires_at,
  };
}

/** Pulls the useful sentence out of a Composio error body without echoing the request. */
export function messageFromErrorBody(body: unknown, fallback: string): { message: string; detail?: string } {
  const parsed = apiErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.error?.message : undefined;
  const fix = parsed.success ? parsed.data.error?.suggested_fix : undefined;
  return {
    message: message ?? fallback,
    detail: [parsed.success ? parsed.data.error?.slug : undefined, fix].filter(Boolean).join(" — ") || undefined,
  };
}
