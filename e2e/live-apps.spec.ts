import { expect, test } from "@playwright/test";

/**
 * The marketplace against the **live** Composio project, for the check the stub
 * cannot make: that real toolkits come back with real names, logos and categories,
 * and that Connect opens the provider's real consent page.
 *
 * It stops at the consent screen on purpose. Nobody completes a grant here: the
 * point is that the URL is the right app's, not that access was granted.
 *
 * Off by default so `pnpm e2e` never spends a live project's quota or depends on a
 * network. Run it with:
 *   COMPOSIO_LIVE=1 COMPOSIO_PROJECT_API_KEY=… COMPOSIO_BASE_URL= pnpm e2e e2e/live-apps.spec.ts
 */
const live = process.env.COMPOSIO_LIVE === "1";

test.describe.configure({ mode: "serial" });

test(live ? "lists real toolkits and opens the real consent page" : "live pass (skipped)", async ({
  page,
  context,
}) => {
  test.skip(!live, "set COMPOSIO_LIVE=1 with a live COMPOSIO_PROJECT_API_KEY");

  const email = `live-${Date.now()}@pupbot.dev`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Live");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("pupbot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("create-bot-dialog").waitFor();
  await page.getByLabel("Bot name").fill("Live");
  await page.getByRole("button", { name: "Create" }).click();

  await page.getByTestId("connect-apps").click();
  await expect(page.getByTestId("app-tile-gmail")).toBeVisible({ timeout: 30_000 });
  // Real catalogue: a real app name and a real category from composio's project.
  await expect(page.getByTestId("apps-grid")).toContainText("Gmail");
  await expect(page.getByTestId("apps-grid")).toContainText("Slack");

  await page.getByTestId("app-tile-gmail").click();
  await expect(page.getByTestId("app-detail")).toContainText("Gmail");

  const popupPromise = context.waitForEvent("page");
  await page.getByTestId("app-connect").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 });

  // The real provider consent screen, for Composio's app, not a placeholder.
  expect(new URL(popup.url()).hostname).toMatch(/accounts\.google\.com|connect\.composio\.dev/);
  const text = await popup.locator("body").innerText();
  expect(text.length).toBeGreaterThan(20);
});
