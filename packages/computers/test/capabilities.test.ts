import { describe, expect, it } from "vitest";
import { Agent37Provider, FakeComputerProvider, InstaboxProvider } from "../src/index.ts";

/**
 * A provider that cannot do something must say so in `capabilities`, because
 * that is what a caller reads before offering the feature. A missing screenshot
 * has to be visible to the code that drives a desktop, not only to a person
 * reading a report.
 */
describe("provider capability metadata", () => {
  const instabox = new InstaboxProvider({ account: "instabox:test", apiKey: "not-a-real-key" });
  const agent37 = new Agent37Provider({ account: "agent37:test", apiKey: "not-a-real-key" });
  const fake = new FakeComputerProvider();

  it("declares Instabox as complete", () => {
    expect(instabox.capabilities).toMatchObject({
      exec: true,
      files: true,
      screenshot: true,
      pausePreservesMemory: true,
      deleteAfter: true,
    });
    expect(instabox.capabilities.unsupported).toEqual({});
  });

  it("declares Agent37's screenshot gap, with the reason a caller needs", () => {
    expect(agent37.capabilities.screenshot).toBe(false);
    expect(agent37.capabilities.unsupported.screenshot).toContain("noVNC");
    // Everything a bot actually runs on is there.
    expect(agent37.capabilities).toMatchObject({
      exec: true,
      pausePreservesMemory: true,
    });
  });

  it("declares Agent37 files as partial, so a base-template instance is expected", () => {
    expect(agent37.capabilities.files).toBe(true);
    expect(agent37.capabilities.partial?.files).toContain("agent37-base");
  });

  it("declares that Agent37 has no delete-after, and names its backstop", () => {
    expect(agent37.capabilities.deleteAfter).toBe(false);
    expect(agent37.capabilities.unsupported.deleteAfter).toContain("auto-sleep");
  });

  it("declares the fake complete, so the contract suite can assert every method", () => {
    expect(fake.capabilities.screenshot).toBe(true);
    expect(fake.capabilities.unsupported).toEqual({});
  });

  it("keeps screenshot-capable providers distinguishable, for ordering", () => {
    // The allocator's label ordering can only prefer a framebuffer provider if
    // the flag exists on the interface rather than inside one implementation.
    const capable = [instabox, fake, agent37].filter((provider) => provider.capabilities.screenshot);
    expect(capable.map((provider) => provider.name)).toEqual(["instabox", "fake"]);
  });
});
