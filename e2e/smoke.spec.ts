import { expect, test } from "@playwright/test";

test("sign up, create a bot, stream a reply, and block an unbound bot", async ({ page }) => {
  const email = `e2e-${Date.now()}@pupbot.dev`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("pupbot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();

  // A brand-new account lands with no bots, so the create dialog is already open.
  await expect(page.getByTestId("create-bot-dialog")).toBeVisible();
  await page.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByTestId("bot-chip")).toContainText("Scout");
  const scoutRow = page.locator('[data-testid^="bot-row-"]').filter({ hasText: "Scout" }).first();
  await expect(scoutRow).toBeVisible();

  // No computer yet: the composer is replaced by the blocked state and its fix.
  const blocked = page.getByTestId("composer-blocked");
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText("doesn't have a computer yet");
  await page.getByRole("button", { name: "Give it a computer" }).click();
  await expect(blocked).toBeHidden({ timeout: 30_000 });

  const composer = page.getByLabel("Message Scout");
  await expect(composer).toBeVisible();
  await composer.fill("hello pup");
  await page.getByTestId("send").click();

  await expect(page.getByText("hello pup")).toBeVisible();

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

  // A second bot has no computer, so its composer stays blocked.
  await page.getByLabel("New bot").click();
  await page.getByLabel("Bot name").fill("Rex");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("bot-chip")).toContainText("Rex");
  await expect(page.getByTestId("composer-blocked")).toContainText("doesn't have a computer yet");
  const rexRow = page.locator('[data-testid^="bot-row-"]').filter({ hasText: "Rex" }).first();
  await expect(rexRow).toBeVisible();
});
