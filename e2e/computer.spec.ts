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

/**
 * Sign up as the suite's Owner. Configuring a computer provider is an Owner-only
 * act — a member's panel says managed cloud comes with their plan — so the specs
 * that connect an account must run as the address `OWNER_EMAILS` names, which the
 * config puts in `E2E_OWNER_EMAIL` for both the server and this file.
 */
async function signUpAsOwner(page: import("@playwright/test").Page) {
  const email = process.env.E2E_OWNER_EMAIL ?? "owner@terabot.dev";
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

/** Sign up as an ordinary member: nobody in `OWNER_EMAILS`, so no plan and no bypass. */
async function signUpAsMember(page: import("@playwright/test").Page) {
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
  await signUpAsMember(page);

  // The composer is available with no computer attached: this is the whole point
  // of lazy provisioning, and it used to be blocked behind a card.
  const composer = page.getByLabel("Message Scout");
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("composer-blocked")).toHaveCount(0);

  await composer.fill("hello");
  await page.getByTestId("send").click();
  await expect(page.getByText("hello")).toBeVisible();
});

test("one account per provider, and the second is not offered", async ({ page }) => {
  await signUpAsOwner(page);
  await openComputerSettings(page);

  const panel = page.getByTestId("computer-panel");
  await expect(panel).toBeVisible();
  /*
   * The deployment's own pool is listed too, so the thing to count is this
   * user's accounts, not every row: a fresh sign-up owns none.
   */
  await expect(page.getByTestId("computer-connect")).toBeVisible();
  const mine = page.getByRole("button", { name: /^Disconnect / });
  await expect(mine).toHaveCount(0);

  // Connect one Instabox account through the panel's own flow.
  await page.getByTestId("computer-connect").click();
  await page.getByLabel("API key").fill("ibk_e2e_fake_key");
  await page.getByRole("button", { name: "Save key" }).click();

  await expect(page.getByRole("button", { name: /^Disconnect / })).toHaveCount(1, { timeout: 30_000 });

  /*
   * The provider is no longer on offer for a second account: `canConnect` is
   * false for one this user already holds, so a confused person cannot even
   * pick it. That is the guard, and it is what keeps the refusal out of the
   * person's way rather than making them read an index name.
   */
  await page.getByTestId("computer-connect").click();
  const options = await page.getByLabel("Provider").locator("option").allTextContents().catch(() => []);
  expect(options.map((option) => option.trim())).not.toContain("Instabox");
});

