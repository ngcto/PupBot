import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { resetEnvCache } from "@terabot/config";
import {
  auth,
  bot,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  findWorkspace,
  message,
  newId,
  user,
} from "@terabot/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

/**
 * The gate at the HTTP boundary, with billing configured.
 *
 * This is the half that cannot be proven with Polar unset: that a member with no
 * plan is genuinely refused when they send a message, that the refusal carries
 * the notice the run uses, and that the Owner is untouched. It runs against the
 * real routes and a real database — only the Polar credentials are stand-ins,
 * which is exactly the part a real account would add.
 *
 * The environment is edited in place, so this file is alone in doing so and
 * restores it at the end.
 */

const ORIGINAL = { ...process.env };

function configureBilling(): void {
  process.env.POLAR_ACCESS_TOKEN = "polar_oat_test_not_a_real_token";
  process.env.POLAR_WEBHOOK_SECRET = "whsec_dGVzdC13ZWJob29rLXNlY3JldC0zMi1ieXRlcw==";
  process.env.POLAR_PLANS = JSON.stringify([{ id: "pro", label: "Pro", productId: "prod_test_1" }]);
  process.env.INSTABOX_API_KEY = "instabox_test_not_a_real_key";
  resetEnvCache();
}

describe("gated message send", () => {
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let conversationId = "";
  let ownerCookie = "";
  const createdUserIds: string[] = [];

  async function signUp(label: string) {
    const email = `gateapi-${label}-${randomUUID()}@terabot.dev`;
    const result = await auth().api.signUpEmail({
      body: { email, password: "gate-api-password", name: "Gate API" },
      returnHeaders: true,
    });
    const set = result.headers.get("set-cookie")?.split(";")[0] ?? "";
    createdUserIds.push(result.response.user.id);
    return { id: result.response.user.id, email, cookie: set };
  }

  beforeAll(async () => {
    configureBilling();
    app = createApp({ enqueue: async () => {} });

    const member = await signUp("member");
    cookie = member.cookie;
    const workspace = (await findWorkspace(member.id)) ?? (await ensureWorkspace(member.id, "Gate API"));

    const botId = newId();
    conversationId = newId();
    await database().insert(bot).values({
      id: botId,
      workspaceId: workspace.id,
      name: "Gated",
      avatar: { shape: "circle", color: "blue" },
      accentColor: "#1884fc",
      instructions: "",
    });
    await database().insert(conversation).values({ id: conversationId, botId, title: "Gated", isPrimary: true });

    // A second account that OWNER_EMAILS names: the bypass must be real.
    const owner = await signUp("owner");
    process.env.OWNER_EMAILS = owner.email;
    resetEnvCache();
    ownerCookie = owner.cookie;

    const ownerWorkspace = (await findWorkspace(owner.id)) ?? (await ensureWorkspace(owner.id, "Owner"));
    const ownerBot = newId();
    const ownerConversation = newId();
    await database().insert(bot).values({
      id: ownerBot,
      workspaceId: ownerWorkspace.id,
      name: "Owned",
      avatar: { shape: "circle", color: "blue" },
      accentColor: "#1884fc",
      instructions: "",
    });
    await database().insert(conversation).values({
      id: ownerConversation,
      botId: ownerBot,
      title: "Owned",
      isPrimary: true,
    });
    (globalThis as { ownerConversationId?: string }).ownerConversationId = ownerConversation;
  });

  afterAll(async () => {
    for (const id of createdUserIds) await database().delete(user).where(eq(user.id, id));
    process.env = { ...ORIGINAL };
    resetEnvCache();
    await closeDatabase();
  });

  const send = (path: string, cookieValue: string) =>
    app.request(`/conversations/${path}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieValue },
      body: JSON.stringify({ text: "hello" }),
    });

  it("refuses a member without a plan, with a 402 and the notice the bot relays", async () => {
    const response = await send(conversationId, cookie);
    expect(response.status).toBe(402);

    const body = (await response.json()) as {
      error: string;
      gate: { code: string; situation: string; resolution: string };
    };
    expect(body.error).toBe("plan_required");
    expect(body.gate.situation).toContain("No cloud plan is active");
    expect(body.gate.resolution).toContain("Settings → Billing");
  });

  it("writes no message for a refused send", async () => {
    await send(conversationId, cookie);
    const rows = await database().select().from(message).where(eq(message.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  });

  it("lets the Owner through even with no subscription", async () => {
    const ownerConversation = (globalThis as { ownerConversationId?: string }).ownerConversationId!;
    const response = await send(ownerConversation, ownerCookie);
    // Not 402: the Owner's message is accepted. The run itself is stubbed out by
    // `enqueue: async () => {}`, so this only asserts the gate stepped aside.
    expect(response.status).toBe(201);
  });

  it("still blocks the member after the Owner was allowed", async () => {
    const response = await send(conversationId, cookie);
    expect(response.status).toBe(402);
  });
});
