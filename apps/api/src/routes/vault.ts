import { auth, bot, database, findWorkspace, secretRequest } from "@terabot/db";
import {
  SecretRequestService,
  VaultService,
  VAULT_KINDS,
  fieldsOf,
  isVaultKind,
} from "@terabot/vault";
import type { VaultKind } from "@terabot/vault";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.ts";
import { sharedSecretBridge } from "../secret-bridge.ts";

const submitSchema = z.object({
  values: z.record(z.string(), z.string().max(4096)).default({}),
  saveToVault: z.boolean().default(true),
  label: z.string().max(120).optional(),
  domain: z.string().max(300).nullable().optional(),
});

const declineSchema = z.object({ decline: z.literal(true) });

/**
 * The ask-the-user card's HTTP surface, and the vault's item surface.
 *
 * What these routes can and cannot carry is the point:
 *
 * - `POST /secret-requests/:id` accepts a value and **returns nothing** — the
 *   response is `{ status }`, so a submitted credential never travels back out.
 * - `GET /secret-requests/:id` returns the question, never the answer.
 * - `GET /vault` returns labels, domains and masked tails. There is no listing route
 *   that can return a value.
 * - `POST /vault/:id/reveal` is the one value-returning route, it is scoped to the
 *   person who owns the item, and the browser only ever uses it behind a re-auth
 *   confirmation, which is why it exists at all.
 */
export const vaultRoutes = new Hono<AppEnv>();

async function workspaceOf(userId: string) {
  return findWorkspace(userId);
}

/** Scope a request to the caller's workspace, and to a bot they own. */
async function scopeRequest(userId: string, requestId: string) {
  const workspace = await workspaceOf(userId);
  if (!workspace) return null;
  const [row] = await database()
    .select({ request: secretRequest })
    .from(secretRequest)
    .innerJoin(bot, eq(secretRequest.botId, bot.id))
    .where(and(eq(secretRequest.id, requestId), eq(secretRequest.workspaceId, workspace.id)))
    .limit(1);
  return row ? { workspace, request: row.request } : null;
}

vaultRoutes
  /** The question a card renders, re-read on load so it survives a refresh. */
  .get("/secret-requests/:id", async (c) => {
    const scoped = await scopeRequest(c.get("user").id, c.req.param("id"));
    if (!scoped) return c.json({ error: "not_found" }, 404);

    const service = new SecretRequestService(database());
    await service.expireOverdue({ workspaceId: scoped.workspace.id, requestId: scoped.request.id });
    const view = await service.get({ workspaceId: scoped.workspace.id, requestId: scoped.request.id });

    return c.json({
      request: {
        id: view.id,
        kind: view.kind,
        reason: view.reason,
        status: view.status,
        expiresAt: view.expiresAt,
        open: view.open,
      },
      /** The fields to render, from the same definitions the vault uses. */
      fields: isVaultKind(view.kind)
        ? fieldsOf(view.kind).map((field) => ({
            name: field.name,
            label: field.label,
            input: field.input,
            secret: field.secret,
            /**
             * Whether the input masks typing. A stored secret is masked, but an expiry
             * is not: hiding MM/YY protects nothing and makes a checkout harder.
             */
            masked: field.secret && field.input === "password",
            optional: field.optional ?? false,
            maxLength: field.maxLength,
            // A hint is copy, not a value: "MM/YY" and "print the key the site showed you".
            hint: field.hint ?? null,
            group: field.group ?? null,
            separator: field.separator ?? null,
          }))
        : [],
      /** The site the value would be saved for, so the card can say it. */
      domain: null,
    });
  })

  /**
   * The person answered. Ticked saves through the vault; unticked holds the value in
   * this process's memory for the waiting run and writes it nowhere.
   */
  .post("/secret-requests/:id", async (c) => {
    const scoped = await scopeRequest(c.get("user").id, c.req.param("id"));
    if (!scoped) return c.json({ error: "not_found" }, 404);

    const body = await c.req.json().catch(() => null);
    const user = c.get("user");
    const service = new SecretRequestService(database());

    // Decline is the same route with one flag: one answer shape, one place to audit.
    const declined = declineSchema.safeParse(body);
    if (declined.success) {
      await service.decline({ workspaceId: scoped.workspace.id, requestId: scoped.request.id });
      sharedSecretBridge().resolve(scoped.request.id, "declined");
      return c.json({ status: "declined" as const });
    }

    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    try {
      const result = await service.submit({
        workspaceId: scoped.workspace.id,
        requestId: scoped.request.id,
        userId: user.id,
        values: parsed.data.values,
        saveToVault: parsed.data.saveToVault,
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        domain: parsed.data.domain ?? null,
      });
      sharedSecretBridge().resolve(scoped.request.id, "provided");
      // `status` and nothing else: no echoed field, no vault id, no hint.
      return c.json({ status: result.status as "provided" });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : "that could not be saved";
      if (code === "invalid_value" || code === "no_domain" || code === "invalid_field") {
        return c.json({ error: "invalid_value", message }, 400);
      }
      if (code === "not_found") return c.json({ error: "not_found" }, 404);
      console.error("[vault] a secret request could not be resolved:", code ?? "unknown");
      return c.json({ error: "internal_error", message: "the value could not be saved" }, 500);
    }
  })

  /** The vault's items: labels, domains, masked tails. */
  .get("/vault", async (c) => {
    const user = c.get("user");
    const workspace = await workspaceOf(user.id);
    if (!workspace) return c.json({ items: [], kinds: [] });

    const kindParam = c.req.query("kind");
    const vault = new VaultService(database());
    const items = await vault.list({
      workspaceId: workspace.id,
      userId: user.id,
      ...(kindParam && isVaultKind(kindParam) ? { kind: kindParam as VaultKind } : {}),
    });

    return c.json({
      items,
      kinds: Object.values(VAULT_KINDS).map((definition) => ({
        kind: definition.kind,
        label: definition.label,
        summary: definition.summary,
        fields: definition.fields,
      })),
    });
  })

  .post("/vault", async (c) => {
    const user = c.get("user");
    const workspace = await workspaceOf(user.id);
    if (!workspace) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as
      | { kind?: string; label?: string; domain?: string | null; values?: Record<string, string> }
      | null;
    if (!body || !isVaultKind(body.kind)) return c.json({ error: "invalid_body" }, 400);

    try {
      const item = await new VaultService(database()).create({
        workspaceId: workspace.id,
        userId: user.id,
        kind: body.kind,
        label: body.label ?? "",
        domain: body.domain ?? null,
        values: body.values ?? {},
      });
      return c.json({ item }, 201);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code) return c.json({ error: code, message: (error as Error).message }, 400);
      throw error;
    }
  })

  .patch("/vault/:id", async (c) => {
    const user = c.get("user");
    const workspace = await workspaceOf(user.id);
    if (!workspace) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as
      | { label?: string; domain?: string | null; values?: Record<string, string> }
      | null;
    if (!body) return c.json({ error: "invalid_body" }, 400);

    try {
      const item = await new VaultService(database()).update({
        workspaceId: workspace.id,
        userId: user.id,
        itemId: c.req.param("id"),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.domain !== undefined ? { domain: body.domain } : {}),
        ...(body.values ? { values: body.values } : {}),
      });
      return c.json({ item });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code) return c.json({ error: code, message: (error as Error).message }, 400);
      throw error;
    }
  })

  .delete("/vault/:id", async (c) => {
    const user = c.get("user");
    const workspace = await workspaceOf(user.id);
    if (!workspace) return c.json({ error: "not_found" }, 404);
    try {
      await new VaultService(database()).remove({
        workspaceId: workspace.id,
        userId: user.id,
        itemId: c.req.param("id"),
      });
      return c.json({ ok: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "not_found") return c.json({ error: "not_found" }, 404);
      throw error;
    }
  })

  /**
   * The one route that returns a value, and only to the person it belongs to.
   *
   * The browser calls it behind a confirm step that re-checks the account password,
   * so a walk-up to an unlocked laptop does not read the vault. Nothing else in the
   * system can read a stored value over HTTP: a bot fills a field instead.
   */
  .post("/vault/:id/reveal", async (c) => {
    const user = c.get("user");
    const workspace = await workspaceOf(user.id);
    if (!workspace) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { password?: string; field?: string };
    if (!body.password) return c.json({ error: "re_auth_required" }, 401);

    try {
      await auth().api.verifyPassword({ body: { password: body.password }, headers: c.req.raw.headers });
    } catch {
      return c.json({ error: "re_auth_failed" }, 401);
    }

    try {
      const revealed = await new VaultService(database()).reveal({
        workspaceId: workspace.id,
        userId: user.id,
        itemId: c.req.param("id"),
        ...(body.field ? { field: body.field } : {}),
      });
      c.header("cache-control", "no-store");
      return c.json(revealed);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "not_found") return c.json({ error: "not_found" }, 404);
      if (code === "unreadable") return c.json({ error: "unreadable", message: (error as Error).message }, 409);
      throw error;
    }
  });

