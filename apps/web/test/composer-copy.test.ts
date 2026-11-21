import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The composer is the one place the product decides whether a person can type.
 *
 * Chat no longer needs a computer: a bot provisions one on the first tool call,
 * so a bot without a machine still answers, and the computer layer explains any
 * refusal in the bot's own words. That makes the old not-a-composer states —
 * "Connecting a computer…", "This bot doesn't have a computer yet.", "Try again"
 * — wrong to render: they told someone to wait for something the product no
 * longer waits for, and put system wording in front of a message that should be
 * the bot's. They are gone on purpose, and this test is what keeps them gone.
 *
 * The one state that still blocks typing is a bot with no model provider, which
 * is not a computer problem at all.
 */
const composer = readFileSync(fileURLToPath(new URL("../components/composer.tsx", import.meta.url)), "utf8");

describe("composer", () => {
  it("does not render computer state cards over the conversation", () => {
    expect(composer).not.toContain('data-testid="composer-allocating"');
    expect(composer).not.toContain("Connecting a computer");
    expect(composer).not.toContain("This bot doesn't have a computer yet.");
    expect(composer).not.toContain("Try again");
  });

  it("still blocks only on a missing model provider, with a plain label", () => {
    const action = /<Button[^>]*>\s*(Add a provider)\s*<\/Button>/.exec(composer);
    expect(action, "the provider action is not a plain literal on the button").not.toBeNull();
    expect(composer).toContain("This bot has no provider yet.");
  });
});
