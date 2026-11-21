import { expect, test } from "@playwright/test";

/**
 * The billing gate's promise, from the browser's side.
 *
 * The suite runs with no Polar configuration — which is how every deployment
 * starts, and how CI runs — so what it proves is the important half: a gate that
 * is switched off changes nothing a person can see. It also covers the surfaces
 * the gate adds, so the read-only Computers copy and the Billing page cannot rot
 * unnoticed.
 */
test("with billing unconfigured, nothing blocks a new account and Billing says so", async ({ page }) => {
  const email = `gate-${Date.now()}@terabot.dev`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Gate Browser");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-gate-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL(/\/b\//, { timeout: 60_000 });
  const dialog = page.getByTestId("create-bot-dialog");
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  // A member with no plan is not refused: the bot is created and the composer is
  // usable, because a computer is obtained lazily on the model's first tool call
  // rather than being a precondition for chatting. Nothing here asks for money.
  await expect(page.getByTestId("bot-chip").first()).toContainText("Scout", { timeout: 60_000 });
  await expect(page.getByLabel("Message Scout")).toBeVisible();
  await expect(page.getByTestId("composer-blocked")).toHaveCount(0);

  // Settings › Computer is read-only for a member and says why, while leaving
  // their own model provider alone.
  // The account avatar opens the menu, and its Settings item opens the dialog.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: /Settings/i }).click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Computer" }).click();
  const readonly = page.getByTestId("computer-readonly");
  await expect(readonly).toBeVisible();
  await expect(readonly).toContainText("Managed cloud comes with your plan");

  // Billing is reachable and honest: unset Polar means free, not "coming soon".
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("Billing is not set up on this deployment")).toBeVisible();
  await expect(page.getByText(/free to use as it stands/)).toBeVisible();
});
