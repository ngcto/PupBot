import { expect, test } from "@playwright/test";

/**
 * Settings → Vault, driven through the real UI.
 *
 * The assertion that matters is not "the row appears" but "no secret is on the
 * page": the list is checked at both the visible-text level and in the HTML source,
 * because a masked value that leaked into a `value` attribute or a `title` would be
 * invisible in text but still in the document.
 */
test("a login is added to the vault and shown masked, with no plaintext in the page source", async ({ page }) => {
  const email = `vault-${Date.now()}@terabot.dev`;
  const password = "fake-vault-e2e-password-9f2";

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Vault Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();

  // A new account lands in the create-bot dialog; dismiss it and go to settings.
  // The dialog's own Close is what the UI offers, so it is what the test uses.
  const createDialog = page.getByTestId("create-bot-dialog");
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Close" }).click();
  await expect(createDialog).toBeHidden();

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Vault" }).click();

  const panel = page.getByTestId("vault-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("vault-empty")).toBeVisible();
  await expect(page.getByTestId("vault-empty")).toContainText("Nothing saved yet");

  // Add a login: name, site, username, password.
  await page.getByTestId("vault-add-login").click();
  const form = page.getByTestId("vault-form");
  await expect(form).toBeVisible();

  await page.getByTestId("vault-label").fill("Example Shop");
  await page.getByTestId("vault-domain").fill("shop.example.test");
  await page.getByTestId("vault-field-login-username").fill("tester@example.test");
  await page.getByTestId("vault-field-login-password").fill(password);
  await page.getByTestId("vault-save").click();

  // Back on the list, the item is there and the password is only a masked tail.
  const list = page.getByTestId("vault-list");
  await expect(list).toBeVisible();
  const row = page.getByTestId(/^vault-row-/).first();
  await expect(row).toContainText("Example Shop");
  await expect(row).toContainText("shop.example.test");
  await expect(row).toContainText("••••");
  await expect(row).not.toContainText(password);

  // The plaintext is nowhere in the document: not in text, not in an attribute.
  const html = await page.content();
  expect(html).not.toContain(password);
  expect(html).not.toContain("tester@example.test" + "'s");

  // The 2FA field is behind Advanced, not in the first screen a person meets.
  await page.getByTestId("vault-add-login").click();
  await expect(page.getByTestId("vault-field-login-totp")).toHaveCount(0);
  await page.getByTestId("vault-advanced").click();
  await expect(page.getByTestId("vault-field-login-totp")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).first().click();

  // Showing a value needs the account password first.
  await row.getByRole("button", { name: /Show a value from Example Shop/ }).click();
  const reveal = page.getByTestId("vault-reveal");
  await expect(reveal).toBeVisible();
  await expect(page.getByTestId("vault-revealed-value")).toHaveCount(0);

  await page.getByTestId("vault-reauth").fill("terabot-e2e-password");
  await page.getByRole("button", { name: "Show value" }).click();
  await expect(page.getByTestId("vault-revealed-value")).toHaveValue(password);

  // A wrong password does not reveal it.
  await page.getByRole("button", { name: "Hide" }).click();
  await page.getByTestId("vault-reauth").fill("not-the-password");
  await page.getByRole("button", { name: "Show value" }).click();
  await expect(page.getByTestId("vault-reveal")).toContainText("That password is not right");
  await expect(page.getByTestId("vault-revealed-value")).toHaveCount(0);

  // Deleting it empties the list again.
  await reveal.getByRole("button", { name: "Close" }).click();
  await row.getByRole("button", { name: /Delete Example Shop/ }).click();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("vault-empty")).toBeVisible({ timeout: 15_000 });
});

test("the three kinds each ask only for their own fields, and a card needs a site", async ({ page }) => {
  const email = `vault-kinds-${Date.now()}@terabot.dev`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Kinds Tester");
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

  // A card form asks for holder, number, expiry, CVC — and requires a site.
  await page.getByTestId("vault-add-card").click();
  await expect(page.getByTestId("vault-field-card-holder")).toBeVisible();
  await expect(page.getByTestId("vault-field-card-number")).toBeVisible();
  await expect(page.getByTestId("vault-field-card-expiry")).toBeVisible();
  await expect(page.getByTestId("vault-field-card-cvc")).toBeVisible();
  await expect(page.getByTestId("vault-field-card-totp")).toHaveCount(0);
  await expect(page.getByTestId("vault-domain")).toBeVisible();

  await page.getByTestId("vault-label").fill("Test card");
  await page.getByTestId("vault-field-card-holder").fill("Ada Lovelace");
  // Card fields group as they are typed and are stored digits-only.
  await page.getByTestId("vault-field-card-number").fill("4000000000000002");
  await expect(page.getByTestId("vault-field-card-number")).toHaveValue("4000 0000 0000 0002");
  await page.getByTestId("vault-field-card-expiry").fill("1229");
  await expect(page.getByTestId("vault-field-card-expiry")).toHaveValue("12/29");
  await page.getByTestId("vault-field-card-cvc").fill("737");

  // No site: refused, with the reason on the form rather than a silent failure.
  await page.getByTestId("vault-save").click();
  await expect(page.getByTestId("vault-form-error")).toBeVisible();
  await expect(page.getByTestId("vault-form-error")).toContainText("site");

  await page.getByTestId("vault-domain").fill("shop.example.test");
  await page.getByTestId("vault-save").click();

  const cardList = page.locator('[data-testid="vault-list"][data-kind="card"]');
  const row = cardList.getByTestId(/^vault-row-/).first();
  await expect(row).toContainText("Test card");
  await expect(row).toContainText("•••• 0002");
  const html = await page.content();
  expect(html).not.toContain("4000 0000 0000 0002");
  expect(html).not.toContain("4000000000000002");

  // Contact info has no required site: an address is not bound to one.
  await page.getByTestId("vault-add-contact").click();
  await expect(page.getByTestId("vault-domain")).toHaveCount(0);
  await page.getByTestId("vault-label").fill("Home");
  await page.getByTestId("vault-field-contact-name").fill("Ada Lovelace");
  await page.getByTestId("vault-field-contact-email").fill("ada@example.test");
  await page.getByTestId("vault-save").click();

  // Each kind gets its own group, so the contact appears under its own heading
  // rather than mixed into the card that is already there.
  const contactList = page.locator('[data-testid="vault-list"][data-kind="contact"]');
  await expect(contactList).toContainText("Home");
  await expect(contactList).toContainText("ada@example.test");
});
