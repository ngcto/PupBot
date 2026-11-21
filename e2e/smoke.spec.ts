import { expect, test } from "@playwright/test";

test("a provider is configured in Settings, then a bot is created from it and streams a reply", async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@terabot.dev`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();

  // A brand-new account lands with no bots, so the create dialog is already open.
  const createDialog = page.getByTestId("create-bot-dialog");
  await expect(createDialog).toBeVisible();

  // The dialog asks for a provider and a model, never for a key or a base URL.
  await expect(createDialog.getByLabel("API key")).toHaveCount(0);
  await expect(createDialog.getByLabel("Base URL")).toHaveCount(0);
  await expect(createDialog.getByRole("button", { name: /Add an endpoint|Sign in/ })).toHaveCount(0);

  await createDialog.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByTestId("bot-chip")).toContainText("Scout");
  const scoutRow = page.locator('[data-testid^="bot-row-"]').filter({ hasText: "Scout" }).first();
  await expect(scoutRow).toBeVisible();

  // No computer yet: the composer is replaced by the blocked state and its fix.
  const blocked = page.getByTestId("composer-blocked");
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText("doesn't have a computer yet");
  // The one action provisions through the allocator and the fake pool (a
  // worker job), not a synchronous stub: the card becomes Awake.
  await page.getByRole("button", { name: "Connect a computer" }).click();
  await expect(blocked).toBeHidden({ timeout: 45_000 });
  await expect(page.getByTestId("computer-status")).toHaveText("Awake", { timeout: 45_000 });

  const composer = page.getByLabel("Message Scout");
  await expect(composer).toBeVisible();
  await composer.fill("hello tera");
  await page.getByTestId("send").click();

  await expect(page.getByText("hello tera")).toBeVisible();

  // Streaming: the visible text grows while the run is in flight.
  const streaming = page.getByTestId("streaming-text");
  await expect(streaming).toBeVisible({ timeout: 30_000 });
  const first = (await streaming.textContent())?.length ?? 0;
  await page.waitForTimeout(900);
  const second = (await streaming.textContent().catch(() => ""))?.length ?? Infinity;
  expect(first).toBeGreaterThan(0);
  expect(second).toBeGreaterThan(first);

  // And it lands as a finished assistant bubble.
  await expect(page.getByText(/Woof\. This came from the local stub endpoint/)).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId("streaming-text")).toBeHidden({ timeout: 20_000 });
  await expect(scoutRow).toContainText("Woof");

  // The provider the bot uses is a Settings row, with its base URL and model count.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Providers" }).click();
  const providerRow = page.getByTestId(/^provider-row-/).first();
  await expect(providerRow).toContainText("Local stub endpoint");
  await expect(providerRow).toContainText("dev/stub/v1");
  await expect(providerRow).toContainText(/model/);
  await expect(providerRow).toContainText("no key");

  // Removing the only provider leaves bot creation on the empty state with a
  // link to Settings, instead of a form that cannot work.
  await providerRow.getByRole("button", { name: "Delete" }).click();
  await providerRow.getByRole("button", { name: "Delete provider" }).click();
  await expect(page.getByTestId("providers-empty")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByLabel("New bot").click();
  const emptyCreate = page.getByTestId("create-bot-no-provider");
  await expect(emptyCreate).toBeVisible();
  await expect(emptyCreate).toContainText("Add a provider first");
  await emptyCreate.getByRole("button", { name: /Settings/ }).click();
  await expect(page.getByTestId("providers-panel")).toBeVisible();
});
