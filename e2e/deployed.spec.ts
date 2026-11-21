import { expect, test } from "@playwright/test";

// Runs only against a deployment: `BASE_URL=https://<project>.vercel.app pnpm e2e`.
test.skip(!process.env.BASE_URL, "set BASE_URL to verify a live deployment");

test("sign up, create a bot, stream a reply, and keep it after reload", async ({ page }) => {
  const email = `deploy-${Date.now()}@terabot.dev`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Deploy Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-deploy-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByTestId("create-bot-dialog")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("bot-chip")).toContainText("Scout", { timeout: 60_000 });

  const blocked = page.getByTestId("composer-blocked");
  await expect(blocked).toBeVisible();
  await page.getByRole("button", { name: "Connect a computer" }).click();
  await expect(blocked).toBeHidden({ timeout: 60_000 });

  const composer = page.getByLabel("Message Scout");
  await composer.fill("In one short sentence, what are you?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("message").first()).toContainText("what are you");

  // The deployment streams through its own model endpoint, so wait for the
  // finished assistant bubble instead of the dev stub's wording.
  const assistant = page.locator('[data-testid="message"][data-role="assistant"]');
  await expect(assistant).toHaveCount(1, { timeout: 120_000 });
  const reply = (await assistant.first().getByTestId("message-text").innerText()).trim();
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).not.toContain("That run stopped");

  await expect(page.getByTestId("streaming-text")).toBeHidden({ timeout: 60_000 });

  // A reload re-reads the transcript from Postgres, not from client state.
  await page.reload();
  await expect(page.getByTestId("bot-chip")).toContainText("Scout", { timeout: 60_000 });
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').first()).toContainText(
    reply.slice(0, 40),
  );
});
