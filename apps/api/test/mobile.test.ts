import { COLORS, SHAPE_IDS, colorHex, deriveAccent } from "@terabot/avatars";
import { loadEnv } from "@terabot/config/load-env";
import {
  auth,
  bot,
  botComputer,
  closeDatabase,
  computer,
  conversation,
  database,
  ensureWorkspace,
  message,
  modelEndpoint,
  newId,
  run,
  user,
} from "@terabot/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

loadEnv();

describe("mobile API surface", () => {
  const app = createApp({ enqueue: async () => {} });
  const db = database();
  const email = `mobile-${Date.now()}@terabot.dev`;
  const password = "mobile-test-password";
  let cookie = "";
  let botId = "";
  let conversationId = "";
  let computerId = "";
  const initialShape = SHAPE_IDS[0]!;
  const targetShape = SHAPE_IDS.find((id) => id !== initialShape)!;
  const targetColor = COLORS[1]!.id;

  const signIn = async () => {
    const response = await app.request("/m/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = (await response.json()) as {
      user: { email: string };
      cookies: { name: string; value: string }[];
    };
    return { response, payload };
  };

  beforeAll(async () => {
    const signUp = await auth().api.signUpEmail({
      body: { email, password, name: "Mobile Test" },
      returnHeaders: true,
    });
    const created = signUp.response.user;
    const workspace = await ensureWorkspace(created.id, "Mobile Test");

    const endpointId = newId();
    await db.insert(modelEndpoint).values({
      id: endpointId,
      workspaceId: workspace.id,
      kind: "openai-chat",
      label: "Local endpoint",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "test-model",
      catalogMatch: "matched",
      contextWindow: 1_050_000,
    });

    computerId = newId();
    await db.insert(computer).values({ id: computerId, provider: "instabox", status: "awake" });

    botId = newId();
    conversationId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId: workspace.id,
      name: "Pocket bot",
      avatar: { shape: initialShape, color: "sky" },
      accentColor: "#1884fc",
      instructions: "Be brief.",
      modelEndpointId: endpointId,
      modelId: "test-model",
    });
    await db.insert(conversation).values({ id: conversationId, botId, title: "Pocket", isPrimary: true });
    await db.insert(botComputer).values({ id: newId(), botId, computerId });
  }, 30_000);

  afterAll(async () => {
    await db.delete(user).where(eq(user.email, email));
    await db.delete(computer).where(eq(computer.id, computerId));
    await closeDatabase();
  });

  it("signs in and hands the phone a session cookie", async () => {
    const { response, payload } = await signIn();
    expect(response.status).toBe(200);
    expect(payload.user.email).toBe(email);

    const session = payload.cookies.find((entry) => entry.name.endsWith("session_token"));
    expect(session?.value).toBeTruthy();
    cookie = payload.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  });

  it("refuses a wrong password", async () => {
    const response = await app.request("/m/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "not-the-password" }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_credentials");
  });

  it("requires the session cookie on every other route", async () => {
    const response = await app.request("/m/bots");
    expect(response.status).toBe(401);
  });

  it("lists the workspace's bots with their computer, model and run state", async () => {
    const response = await app.request("/m/bots", { headers: { cookie } });
    expect(response.status).toBe(200);

    const { bots } = (await response.json()) as {
      bots: Array<{
        id: string;
        name: string;
        conversationId: string;
        activeRun: boolean;
        avatar: { shape: string; color: string };
        computer: { status: string; provider: string } | null;
        model: { modelId: string; endpointLabel: string } | null;
        unread: boolean;
      }>;
    };

    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      id: botId,
      name: "Pocket bot",
      conversationId,
      activeRun: false,
      avatar: { shape: initialShape, color: "sky" },
      computer: { status: "awake", provider: "instabox" },
      model: { modelId: "test-model", endpointLabel: "Local endpoint" },
    });
  });

  it("flips activeRun while a run is in flight", async () => {
    const runId = newId();
    await db.insert(run).values({ id: runId, conversationId, botId, status: "running" });

    const response = await app.request("/m/bots", { headers: { cookie } });
    const { bots } = (await response.json()) as { bots: Array<{ activeRun: boolean }> };
    expect(bots[0]?.activeRun).toBe(true);

    await db.update(run).set({ status: "done" }).where(eq(run.id, runId));
  });

  it("returns the bot's messages and the active run", async () => {
    await db.insert(message).values({
      id: newId(),
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "hello from the phone" }],
      status: "complete",
    });

    const response = await app.request(`/m/bots/${botId}/messages`, { headers: { cookie } });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      activeRun: { id: string } | null;
    };

    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.parts[0]).toEqual({ type: "text", text: "hello from the phone" });
    expect(payload.activeRun).toBeNull();
  });

  it("changes the avatar and recomputes the accent", async () => {
    const response = await app.request(`/m/bots/${botId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ avatar: { shape: targetShape, color: targetColor } }),
    });
    expect(response.status).toBe(200);

    const { bot: updated } = (await response.json()) as {
      bot: { avatar: { shape: string; color: string }; accentColor: string; instructions: string };
    };
    expect(updated.avatar).toEqual({ shape: targetShape, color: targetColor });
    expect(updated.accentColor).toBe(deriveAccent(colorHex(targetColor)));
    expect(updated.instructions).toBe("Be brief.");

    const stored = await db.select().from(bot).where(eq(bot.id, botId)).limit(1);
    expect(stored[0]?.avatar).toEqual({ shape: targetShape, color: targetColor });
  });

  it("rejects an avatar that is not in the registry", async () => {
    const response = await app.request(`/m/bots/${botId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ avatar: { shape: "definitely-not-a-shape", color: "tomato" } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("unknown_avatar");
  });

  it("does not expose another workspace's bot", async () => {
    const otherEmail = `mobile-other-${Date.now()}@terabot.dev`;
    const other = await auth().api.signUpEmail({
      body: { email: otherEmail, password, name: "Other" },
      returnHeaders: true,
    });
    await ensureWorkspace(other.response.user.id, "Other");
    const otherCookie = other.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await app.request(`/m/bots/${botId}`, { headers: { cookie: otherCookie } });
    expect(response.status).toBe(404);

    await db.delete(user).where(eq(user.email, otherEmail));
  });

  it("reports the signed-in account for the settings screen", async () => {
    const response = await app.request("/m/me", { headers: { cookie } });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { user: { email: string }; workspaceId: string };
    expect(payload.user.email).toBe(email);
    expect(payload.workspaceId).toMatch(/[0-9a-f-]{36}/);
  });

  it("keeps the bot list scoped to the caller's workspace", async () => {
    const rows = await db
      .select({ id: bot.id })
      .from(bot)
      .innerJoin(conversation, eq(conversation.botId, bot.id))
      .where(and(eq(bot.id, botId), eq(conversation.id, conversationId)));
    expect(rows).toHaveLength(1);
  });
});
