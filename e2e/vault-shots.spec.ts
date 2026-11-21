import { expect, test } from "@playwright/test";

/**
 * Screenshots of the vault surfaces and the ask-the-user card, for the PR and the
 * report. Run with `pnpm exec playwright test e2e/vault-shots.spec.ts`, output lands
 * in `e2e/screens/`.
 *
 * Nothing here asserts behaviour — `vault.spec.ts` does that. These exist so the
 * review can see the surfaces without running the app.
 */

const OUT = "e2e/screens";

test.use({ viewport: { width: 1440, height: 900 } });

async function signUpAndOpenVault(page: import("@playwright/test").Page, tag: string) {
  const email = `shots-${tag}-${Date.now()}@terabot.dev`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Ng");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();

  const createDialog = page.getByTestId("create-bot-dialog");
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Close" }).click();
  await expect(createDialog).toBeHidden();

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Vault" }).click();
  await expect(page.getByTestId("vault-panel")).toBeVisible();
}

test("the vault add form, for a login", async ({ page }) => {
  await signUpAndOpenVault(page, "form");
  await page.getByTestId("vault-add-login").click();
  await expect(page.getByTestId("vault-form")).toBeVisible();
  await page.getByTestId("vault-label").fill("GitHub");
  await page.getByTestId("vault-domain").fill("github.com");
  await page.getByTestId("vault-field-login-username").fill("octocat@example.test");
  await page.getByTestId("vault-field-login-password").fill("fake-not-a-real-password");
  await page.screenshot({ path: `${OUT}/vault-add-login.png` });

  // The same form with Advanced open, which is where the 2FA key lives.
  await page.getByTestId("vault-advanced").click();
  await page.screenshot({ path: `${OUT}/vault-add-login-advanced.png` });
});

test("the vault list, masked", async ({ page }) => {
  await signUpAndOpenVault(page, "list");

  // A login.
  await page.getByTestId("vault-add-login").click();
  await page.getByTestId("vault-label").fill("GitHub");
  await page.getByTestId("vault-domain").fill("github.com");
  await page.getByTestId("vault-field-login-username").fill("octocat@example.test");
  await page.getByTestId("vault-field-login-password").fill("fake-not-a-real-password");
  await page.getByTestId("vault-save").click();
  await expect(page.getByTestId("vault-list")).toBeVisible();

  // A card.
  await page.getByTestId("vault-add-card").click();
  await page.getByTestId("vault-label").fill("Personal card");
  await page.getByTestId("vault-domain").fill("shop.example.test");
  await page.getByTestId("vault-field-card-holder").fill("Ada Lovelace");
  await page.getByTestId("vault-field-card-number").fill("4000000000000002");
  await page.getByTestId("vault-field-card-expiry").fill("1229");
  await page.getByTestId("vault-field-card-cvc").fill("737");
  await page.getByTestId("vault-save").click();

  // Contact info.
  await page.getByTestId("vault-add-contact").click();
  await page.getByTestId("vault-label").fill("Home");
  await page.getByTestId("vault-field-contact-name").fill("Ada Lovelace");
  await page.getByTestId("vault-field-contact-email").fill("ada@example.test");
  // Phone, address and the rest are optional, so they live behind Advanced.
  await page.getByTestId("vault-advanced").click();
  await page.getByTestId("vault-field-contact-phone").fill("+84 000 000 000");
  await page.getByTestId("vault-save").click();

  await expect(page.locator('[data-testid="vault-list"][data-kind="contact"]')).toBeVisible();
  await page.screenshot({ path: `${OUT}/vault-list-masked.png` });
});
