import { loadEnv } from "@pupbot/config/load-env";
import { createApp } from "../src/app.ts";
import {
  auth,
  bot,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  modelEndpoint,
  newId,
  user,
} from "@pupbot/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnv();

interface Person {
  cookie: string;
  email: string;
  conversationId: string;
}

describe("attachments", () => {
  const app = createApp({ enqueue: async () => {} });
  const people: Person[] = [];
  const stamp = Date.now();

  /** A user with an endpoint, a bot and one conversation, ready to send. */
  async function signUp(label: string): Promise<Person> {
    const email = `attach-${label}-${stamp}@pupbot.dev`;
    const signUpResult = await auth().api.signUpEmail({
      body: { email, password: "attachment-test-password", name: label },
      returnHeaders: true,
    });
    const cookie = signUpResult.headers.get("set-cookie")?.split(";")[0] ?? "";
    const space = await ensureWorkspace(signUpResult.response.user.id, label);

    const endpointId = newId();
    await database()
      .insert(modelEndpoint)
      .values({
        id: endpointId,
        workspaceId: space.id,
        kind: "openai-chat",
        label: `${label} endpoint`,
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: "test-model",
        catalogMatch: "unmatched",
      });

    const botId = newId();
    const conversationId = newId();
    await database()
      .insert(bot)
      .values({
        id: botId,
        workspaceId: space.id,
        name: `${label} bot`,
        avatar: { shape: "pup", color: "amber" },
        accentColor: "#f69412",
        instructions: "Test bot.",
        modelEndpointId: endpointId,
        modelId: "test-model",
      });
    await database().insert(conversation).values({ id: conversationId, botId, title: "Test" });

    const person = { cookie, email, conversationId };
    people.push(person);
    return person;
  }

  function file(name: string, body: string, mime: string): FormData {
    const form = new FormData();
    form.append("file", new File([body], name, { type: mime }));
    return form;
  }

  async function upload(person: Person, form: FormData): Promise<{ id: string; name: string }> {
    const response = await app.request("/attachments", { method: "POST", headers: { cookie: person.cookie }, body: form });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string };
  }

  function send(person: Person, attachments: Array<{ id: string; name?: string; size?: number; mime?: string }>, text = "") {
    return app.request(`/conversations/${person.conversationId}/messages`, {
      method: "POST",
      headers: { cookie: person.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        attachments: attachments.map((entry) => ({ name: "file", size: 1, mime: "text/plain", ...entry })),
      }),
    });
  }

  beforeAll(async () => {
    await signUp("alice");
    await signUp("bob");
  }, 60_000);

  afterAll(async () => {
    for (const person of people) {
      await database().delete(user).where(eq(user.email, person.email));
    }
    await closeDatabase();
  });

  it("claims a pending upload only for the workspace that uploaded it", async () => {
    const [alice, bob] = people as [Person, Person];
    const file1 = await upload(alice, file("notes.txt", "alice only", "text/plain"));

    // Bob holds Alice's upload id: he cannot adopt it, and nothing is written.
    const stolen = await send(bob, [file1]);
    expect(stolen.status).toBe(400);
    expect(((await stolen.json()) as { error: string }).error).toBe("invalid_attachment");
    const bobState = await app.request(`/conversations/${bob.conversationId}/state`, { headers: { cookie: bob.cookie } });
    expect(((await bobState.json()) as { messages: unknown[] }).messages).toHaveLength(0);

    // The owner can send it, and then read the bytes back.
    const sent = await send(alice, [file1]);
    expect(sent.status).toBe(201);
    const download = await app.request(`/attachments/${file1.id}`, { headers: { cookie: alice.cookie } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("alice only");

    // Bob still cannot read it, and nobody can claim it a second time.
    const forbidden = await app.request(`/attachments/${file1.id}`, { headers: { cookie: bob.cookie } });
    expect(forbidden.status).toBe(404);
    expect((await send(alice, [file1])).status).toBe(400);
  }, 60_000);

  it("downloads a unicode filename instead of failing on the header", async () => {
    const [alice] = people as [Person, Person];
    const report = await upload(alice, file("报告.pdf", "%PDF-1.4 test", "application/pdf"));

    expect((await send(alice, [report])).status).toBe(201);
    const download = await app.request(`/attachments/${report.id}`, { headers: { cookie: alice.cookie } });
    expect(download.status).toBe(200);

    const disposition = download.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("报告.pdf")}`);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  }, 60_000);

  it("downloads markup instead of rendering it on the app's origin", async () => {
    const [alice] = people as [Person, Person];
    const page = await upload(alice, file("page.html", "<script>alert(1)</script>", "text/html"));

    expect((await send(alice, [page])).status).toBe(201);
    const download = await app.request(`/attachments/${page.id}`, { headers: { cookie: alice.cookie } });
    expect(download.status).toBe(200);

    expect(download.headers.get("content-disposition")?.startsWith("attachment;")).toBe(true);
    expect(download.headers.get("content-security-policy")).toBe("sandbox");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  }, 60_000);
});
