import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The hosted suite has to click the composer's blocked-state action, and it
 * looked for the wording this component had before NGS-57 renamed it. The copy
 * lives here and nowhere else, so reading it out of the source is what stops the
 * spec drifting again the next time the label changes.
 */
const composer = readFileSync(fileURLToPath(new URL("../components/composer.tsx", import.meta.url)), "utf8");

describe("composer copy", () => {
  it("renders an unbound bot's action as the label the deployed spec clicks", () => {
    const action = /<Button[^>]*>\s*\{(unbound \? "([^"]+)" : "([^"]+)")}\s*<\/Button>/.exec(composer);
    expect(action, "the action label is not a plain literal on the button").not.toBeNull();
    expect(action![2]).toBe("Connect a computer");
  });

  it("renders a blocked bot's action as its retry label", () => {
    expect(composer).toContain(': "Try again"}');
  });

  it("shows a resolving spinner testid that the spec waits to disappear", () => {
    expect(composer).toContain('data-testid="composer-allocating"');
  });
});
