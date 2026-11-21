import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * The ask-the-user card, for all three kinds, captured from the real UI.
 *
 * The card is rendered from a `secret_request` row, so the test seeds one directly
 * in Postgres — the same row the bot's `vault_request` tool writes. That keeps the
 * screenshot honest: nothing about the card is faked, only the row that would
 * normally arrive from a run.
 *
 * Output lands in `e2e/screens/`.
 */

const OUT = "e2e/screens";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terabot:terabot@localhost:5432/terabot";

function sql(statement: string): string {
  return execFileSync("psql", [DATABASE_URL, "-tAc", statement], { encoding: "utf8" }).trim();
}

/**
 * A run plus a pending request, inserted directly.
 *
 * A real card arrives from a run that called `vault_request`; a run needs a
 * computer to exist, and a screenshot does not. The rows written here are exactly
 * the rows that tool writes, so the card's own code path is the one under the
 * camera — only the trigger is synthetic.
 */
function seedRequest(email: string, kind: "login" | "card" | "contact", reason: string): string {
  const target = sql(
    `select b.id || ' ' || c.id || ' ' || b.workspace_id
       from bot b join conversation c on c.bot_id = b.id
       join workspace w on w.id = b.workspace_id
       join "user" u on u.id = w.owner_id
      where u.email = '${email}' limit 1`,
  );
  if (!target) throw new Error(`no bot for ${email}`);
  const [botId = "", conversationId = "", workspaceId = ""] = target.split(" ");

  const runId = sql(`select gen_random_uuid()`);
  sql(
    `insert into run (id, conversation_id, bot_id, status, started_at)
     values ('${runId}', '${conversationId}', '${botId}', 'running', now())`,
  );

  const id = sql(`select gen_random_uuid()`);
  sql(
    `insert into secret_request (id, run_id, conversation_id, workspace_id, bot_id, kind, reason, fields, expires_at)
     values ('${id}', '${runId}', '${conversationId}', '${workspaceId}', '${botId}', '${kind}', '${reason}', '[]'::jsonb, now() + interval '3 minutes')`,
  );
  return id;
}

async function signUp(page: import("@playwright/test").Page, tag: string): Promise<string> {
  const email = `card-${tag}-${Date.now()}@terabot.dev`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Ng");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("terabot-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();

  // Create a bot, which also makes the conversation and the run a card hangs from.
  const createDialog = page.getByTestId("create-bot-dialog");
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel("Bot name").fill("Scout");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("bot-chip")).toContainText("Scout");

  return email;
}

test.describe.configure({ mode: "serial" });

for (const kind of ["login", "card", "contact"] as const) {
  test(`the ${kind} card, as the person sees it`, async ({ page }) => {
    const email = await signUp(page, kind);
    const reason =
      kind === "login"
        ? "The shop needs your password before it will show the order."
        : kind === "card"
          ? "Checkout needs a card to pay for the order."
          : "The delivery form needs your name, email and address.";

    seedRequest(email, kind, reason);

    // A reload reads the pending request from the database, which is the same path
    // that makes the card survive a refresh for a real person.
    await page.reload();
    const card = page.getByTestId("secret-request-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-kind", kind);
    await expect(page.getByTestId("secret-request-reason")).toContainText(reason.slice(0, 20));
    // The two buttons, and the checkbox defaulted on.
    await expect(page.getByTestId("secret-confirm")).toHaveText("Confirm");
    await expect(page.getByTestId("secret-decline")).toHaveText("Decline");
    await expect(page.getByTestId("save-to-vault")).toBeChecked();

    await page.screenshot({ path: `${OUT}/card-${kind}.png` });
  });
}
