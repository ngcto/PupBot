import { serverEnv } from "@pupbot/config";
import { loadEnv } from "@pupbot/config/load-env";
import { and, eq } from "drizzle-orm";
import { auth } from "./auth.ts";
import { closeDatabase, database } from "./client.ts";
import { encryptSecret } from "./crypto.ts";
import { newId } from "./ids.ts";
import {
  bot,
  botComputer,
  computer,
  computerAccount,
  conversation,
  message,
  modelCatalog,
  modelEndpoint,
  user,
} from "./schema.ts";
import { ensureWorkspace } from "./workspace.ts";

const DEMO_EMAIL = "demo@pupbot.dev";
const DEMO_PASSWORD = "pupbot-demo";
const DEMO_NAME = "Ng";

const STUB_BASE_URL = () => (process.env.API_URL ?? "http://localhost:8787").replace(/\/+$/, "") + "/dev/stub/v1";

loadEnv();

async function seed() {
  const db = database();

  // The seed creates a known-password demo account, so it never touches a
  // production database.
  if (serverEnv().NODE_ENV === "production") {
    console.log("refusing to seed: NODE_ENV is production");
    await closeDatabase();
    return;
  }

  const existing = await db.select().from(user).where(eq(user.email, DEMO_EMAIL)).limit(1);
  let userId = existing[0]?.id;

  if (!userId) {
    const result = await auth().api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
    });
    userId = result.user.id;
    console.log(`created demo user ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } else {
    console.log(`demo user ${DEMO_EMAIL} already exists`);
  }

  const workspace = await ensureWorkspace(userId, DEMO_NAME);

  const [catalog] = await db
    .insert(modelCatalog)
    .values({
      id: newId(),
      provider: "pupbot",
      modelId: "pup-stub",
      name: "Pup stub (dev)",
      contextWindow: 100_000,
      maxOutput: 8_192,
      pricing: { input: 0, output: 0 },
      modalities: { input: ["text"], output: ["text"] },
      toolSupport: false,
      reasoning: false,
    })
    .onConflictDoUpdate({
      target: [modelCatalog.provider, modelCatalog.modelId],
      set: { name: "Pup stub (dev)" },
    })
    .returning();

  // A new workspace already carries this endpoint from ensureWorkspace, and the
  // seed is run again on existing databases, so look it up before inserting a
  // second copy.
  const endpointId =
    (
      await db
        .select({ id: modelEndpoint.id })
        .from(modelEndpoint)
        .where(and(eq(modelEndpoint.workspaceId, workspace.id), eq(modelEndpoint.modelId, "pup-stub")))
        .limit(1)
    )[0]?.id ??
    (
      await db
        .insert(modelEndpoint)
        .values({
          id: newId(),
          workspaceId: workspace.id,
          kind: "openai-chat",
          label: "Local stub endpoint",
          baseUrl: STUB_BASE_URL(),
          modelId: "pup-stub",
          modelCatalogId: catalog?.id,
          catalogMatch: "matched",
          contextWindow: 100_000,
        })
        .returning({ id: modelEndpoint.id })
    )[0]?.id;

  if (!endpointId) throw new Error("could not create the stub model endpoint");

  const account =
    (
      await db
        .select()
        .from(computerAccount)
        .where(and(eq(computerAccount.provider, "fake"), eq(computerAccount.label, "Stub pool")))
        .limit(1)
    )[0] ??
    (
      await db
        .insert(computerAccount)
        .values({
          id: newId(),
          provider: "fake",
          label: "Stub pool",
          encryptedCredential: encryptSecret("stub-account-credential"),
          status: "active",
          capacity: 5,
        })
        .returning()
    )[0];

  const box =
    (await db.select().from(computer).where(eq(computer.externalId, "stub-seeded-box")).limit(1))[0] ??
    (
      await db
        .insert(computer)
        .values({
          id: newId(),
          accountId: account?.id,
          provider: "fake",
          externalId: "stub-seeded-box",
          status: "awake",
          specs: { vcpus: 4, memMiB: 8192 },
          lastUsedAt: new Date(),
        })
        .returning()
    )[0];

  const seeds = [
    {
      name: "Pup",
      shape: "mug",
      color: "amber",
      accent: "#f69412",
      primary: true,
      hidden: false,
      bound: true,
      instructions:
        "You are Pup, a cheerful bot with your own computer. Keep answers short, concrete and friendly.",
      history: [
        {
          role: "user" as const,
          text: "Hey Pup, can you take a look at the repo and tell me where the streaming code lives?",
        },
        {
          role: "assistant" as const,
          text: "**On it.** The streaming path is three files: the run loop in `packages/agent/src/run.ts`, the SSE endpoint in `apps/api/src/routes/runs.ts`, and the client subscriber in the web app.\n\n- the worker appends every delta to `run_event`\n- the API replays from a sequence number\n- a reconnect loses nothing",
        },
      ],
    },
    {
      name: "Rex",
      shape: "chat",
      color: "sky",
      accent: "#1884fc",
      primary: false,
      hidden: false,
      bound: false,
      instructions: "You are Rex, a methodical research bot.",
      history: [{ role: "user" as const, text: "Rex, what should we build next?" }],
    },
    {
      name: "Mochi",
      shape: "sprout",
      color: "leaf",
      accent: "#14c370",
      primary: false,
      hidden: true,
      bound: false,
      instructions: "You are Mochi.",
      history: [],
    },
  ];

  const created: string[] = [];

  for (const [index, seedBot] of seeds.entries()) {
    const found = await db
      .select()
      .from(bot)
      .where(and(eq(bot.workspaceId, workspace.id), eq(bot.name, seedBot.name)))
      .limit(1);
    if (found[0]) continue;

    const botId = newId();
    const conversationId = newId();

    await db.insert(bot).values({
      id: botId,
      workspaceId: workspace.id,
      name: seedBot.name,
      avatar: { shape: seedBot.shape, color: seedBot.color },
      accentColor: seedBot.accent,
      instructions: seedBot.instructions,
      modelEndpointId: endpointId,
      modelId: "pup-stub",
      pinned: index === 0,
      hidden: seedBot.hidden,
      position: index,
    });

    await db.insert(conversation).values({
      id: conversationId,
      botId,
      title: seedBot.name,
      isPrimary: seedBot.primary,
      lastMessagePreview: seedBot.history.at(-1)?.text.slice(0, 160) ?? null,
    });

    if (seedBot.bound && box) {
      await db.insert(botComputer).values({
        id: newId(),
        botId,
        computerId: box.id,
        boundAt: new Date(),
      });
    }

    let offset = seedBot.history.length;
    for (const entry of seedBot.history) {
      await db.insert(message).values({
        id: newId(),
        conversationId,
        role: entry.role,
        parts: [{ type: "text", text: entry.text }],
        status: "complete",
        createdAt: new Date(Date.now() - offset * 4 * 60 * 1000),
      });
      offset -= 1;
    }

    created.push(seedBot.name);
  }

  if (created.length === 0) console.log("bots already seeded");
  else console.log(`created bots: ${created.join(", ")}`);

  console.log(`\n  sign in at http://localhost:3000/sign-in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
  await closeDatabase();
}

await seed();
