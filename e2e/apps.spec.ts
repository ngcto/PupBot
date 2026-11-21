import { expect, test } from "@playwright/test";
import type { StubToolkit } from "./composio-stub.ts";

/**
 * The marketplace against the Composio stub at the network edge: browse, search,
 * connect (opens Composio's hosted link in a new window and polls until the
 * connection is active), see the connected state, pick it for a bot, disconnect.
 *
 * No live project key and no real OAuth grant are involved: everything talks to
 * e2e/composio-stub.ts through the app's real client.
 */

const STUB = `${process.env.COMPOSIO_STUB_URL ?? "http://127.0.0.1:8799"}`;

async function resetStub() {
  await fetch(`${STUB}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
}

async function stubState() {
  const response = await fetch(`${STUB}/_state`);
  return response.json() as Promise<{
    authConfigs: number;
    connections: Array<{ id: string; toolkit: string; status: string }>;
    toolkits: StubToolkit[];
  }>;
}

async function signUp(page: import("@playwright/test").Page) {
  const email = `apps-${Date.now()}-${Math.random().toString(16).slice(2)}@pupbot.dev`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Apps Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("pupbot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("create-bot-dialog").waitFor();
  await page.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("bot-chip")).toContainText("Scout");
}

test.beforeEach(async () => {
  await resetStub();
});

test("connect an app through Composio, then disconnect it", async ({ page, context }) => {
  await signUp(page);

  await page.getByTestId("connect-apps").click();
  await expect(page.getByTestId("apps-dialog")).toBeVisible();

  // The grid is real data: names, descriptions and the state of every app.
  await expect(page.getByTestId("app-tile-gmail")).toBeVisible();
  await expect(page.getByTestId("app-tile-github")).toBeVisible();
  await expect(page.getByTestId("apps-grid")).toContainText("Gmail");

  // The one this beta cannot connect says so, without a button that would fail.
  await page.getByTestId("app-tile-twitter").click();
  await expect(page.getByTestId("app-needs-setup")).toBeVisible();
  await expect(page.getByTestId("app-connect")).toHaveCount(0);

  // Search narrows to the app asked for, and no results is a real state.
  await page.getByLabel("Search apps").fill("github");
  await expect(page.getByTestId("app-tile-github")).toBeVisible();
  await expect(page.getByTestId("app-tile-gmail")).toHaveCount(0);
  await page.getByLabel("Search apps").fill("zzzzz");
  await expect(page.getByTestId("apps-empty")).toContainText("No apps match that");
  await page.getByLabel("Search apps").fill("");
  await expect(page.getByTestId("app-tile-gmail")).toBeVisible();

  // Connect: Composio's hosted page opens in a new window; we stop there.
  await page.getByTestId("app-tile-gmail").click();
  const popupPromise = context.waitForEvent("page");
  await page.getByTestId("app-connect").click();
  const popup = await popupPromise;
  // The window opens on the click (so the browser allows it) and navigates to the
  // URL once the server answers, so wait for the address rather than the handle.
  await expect(popup.locator("h1")).toContainText("Consent for ca_", { timeout: 20_000 });
  expect(popup.url()).toContain("/_consent/ca_");
  await popup.close();

  // Polling is what turns it active; the dialog does that on its own.
  await expect(page.getByTestId("app-connected")).toBeVisible({ timeout: 20_000 });
  expect((await stubState()).connections[0]?.status).toBe("ACTIVE");

  // The bot settings surface lists it and can grant it to this bot. Its row menu
  // is the way into that dialog today, so the test goes the way a person would.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("apps-dialog")).toBeHidden();
  const scoutRow = page.locator('[data-testid^="bot-row-"]').filter({ hasText: "Scout" }).first();
  await scoutRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename Bot" }).click();
  await expect(page.getByTestId("bot-settings-dialog")).toBeVisible();
  await expect(page.getByTestId("bot-app-gmail")).toContainText("Gmail");
  await page.getByLabel("Let Scout use Gmail").click();
  // The toggle is stored; the surface says plainly that nothing reads it yet.
  await expect(page.getByTestId("bot-settings-dialog")).toContainText("no tool-calling loop");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bot-settings-dialog")).toBeHidden();

  // Disconnect revokes at Composio, not only in our database.
  await page.getByTestId("connect-apps").click();
  await page.getByTestId("app-tile-gmail").click();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("app-connect")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await stubState()).connections.length).toBe(0);
});

test("a Composio failure is shown as an error, not as an empty catalogue", async ({ page }) => {
  await signUp(page);
  await fetch(`${STUB}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brokenMs: 15_000 }),
  });

  await page.getByTestId("connect-apps").click();
  await expect(page.getByTestId("apps-empty")).toContainText(/Couldn't load apps|Composio/);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a connection waiting on approval says so until it lands", async ({ page }) => {
  await signUp(page);
  await fetch(`${STUB}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdNext: true }),
  });

  await page.getByTestId("connect-apps").click();
  await page.getByTestId("app-tile-slack").click();

  const popupPromise = page.context().waitForEvent("page");
  await page.getByTestId("app-connect").click();
  const popup = await popupPromise;
  await popup.close();

  await expect(page.getByTestId("app-pending")).toContainText("Waiting for approval");
  const pending = (await stubState()).connections[0];
  expect(pending?.status).toBe("INITIALIZING");
});

test("the catalogue continues past the first page", async ({ page }) => {
  await signUp(page);
  // A second page only exists if the app follows Composio's cursor, which the default
  // fixtures never produce.
  // The app asks Composio for 60 per page, so a second page needs a longer catalogue.
  const extra: StubToolkit[] = Array.from({ length: 61 }, (_, index) => ({
    slug: `extra-${index}`,
    name: `Extra ${index}`,
    description: "One of the apps past the first page.",
    authSchemes: ["API_KEY"],
    managedAuthSchemes: [],
    categories: ["productivity"],
  }));
  await fetch(`${STUB}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolkits: [...(await stubState()).toolkits, ...extra] }),
  });

  await page.getByTestId("connect-apps").click();
  await expect(page.getByTestId("apps-more")).toBeVisible();
  await expect(page.getByTestId("app-tile-extra-60")).toHaveCount(0);

  await page.getByTestId("apps-more").click();
  await expect(page.getByTestId("app-tile-extra-60")).toBeVisible();
  // The first page is still there, and the control goes away at the end of the list.
  await expect(page.getByTestId("app-tile-gmail")).toBeVisible();
  await expect(page.getByTestId("apps-more")).toHaveCount(0);
});
