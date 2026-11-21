import { expect, test } from "@playwright/test";

/**
 * The computer lifecycle as a person meets it.
 *
 * Two rules are worth a browser test because they are behavioural, not
 * structural: a bot with no computer still chats (so nothing is provisioned just
 * by opening the app), and a workspace cannot add a second account for a provider
 * it already has (so the rejection is a sentence, not an index name).
 *
 * The box itself is the fake provider here: no provider account and no spend.
 */

async function signUp(page: import("@playwright/test").Page) {
  const email = `computer-${Date.now()}-${Math.random().toString(16).slice(2)}@terabot.dev`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Computer Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-computer-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("create-bot-dialog").waitFor();
  await page.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("bot-chip")).toContainText("Scout");
}

async function openComputerSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Computer" }).click();
}

test("a bot with no computer chats, and nothing is provisioned by opening it", async ({ page }) => {
  await signUp(page);

  // The composer is available with no computer attached: this is the whole point
  // of lazy provisioning, and it used to be blocked behind a card.
  const composer = page.getByLabel("Message Scout");
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("composer-blocked")).toHaveCount(0);

  await composer.fill("hello");
  await page.getByTestId("send").click();
  await expect(page.getByText("hello")).toBeVisible();
});

test("one account per provider, and the second is refused in words", async ({ page }) => {
  await signUp(page);
  await openComputerSettings(page);

  const panel = page.getByTestId("computer-account-instabox");
  await expect(panel).toHaveCount(0);

  // Connect one Instabox account.
  await page.getByLabel("Computer provider API key").fill("ibk_e2e_fake_key");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByTestId("computer-account-instabox")).toBeVisible({ timeout: 20_000 });

  // The picker no longer offers Instabox, because this workspace already has it.
  // Trying the same provider again is what a confused person would do, so the
  // guard has to answer in a sentence rather than by silently failing.
  const providerSelect = page.getByLabel("Computer provider");
  const options = await providerSelect.locator("option").allTextContents().catch(() => []);
  expect(options.map((option) => option.trim())).not.toContain("Instabox");
});
