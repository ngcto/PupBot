import { describe, expect, it } from "vitest";
import { resolveUpdateSource } from "../src/shared/updates.ts";

const never = () => false;
const always = () => true;

describe("resolveUpdateSource", () => {
  it("prefers a feed given at launch", () => {
    expect(
      resolveUpdateSource({
        runtimeFeedUrl: "https://updates.terabot.ai/desktop",
        isPackaged: true,
        bundledFeedPath: "/Applications/Terabot.app/Contents/Resources/app-update.yml",
        fileExists: always,
      }),
    ).toEqual({ kind: "runtime", feedUrl: "https://updates.terabot.ai/desktop" });
  });

  it("uses the feed the build embedded when nothing overrides it", () => {
    expect(
      resolveUpdateSource({
        runtimeFeedUrl: undefined,
        isPackaged: true,
        bundledFeedPath: "/opt/Terabot/resources/app-update.yml",
        fileExists: (path) => path.endsWith("app-update.yml"),
      }),
    ).toEqual({ kind: "bundled" });
  });

  it("is not fooled by a missing bundled file", () => {
    expect(
      resolveUpdateSource({
        runtimeFeedUrl: undefined,
        isPackaged: true,
        bundledFeedPath: "/opt/Terabot/resources/app-update.yml",
        fileExists: never,
      }),
    ).toEqual({ kind: "none" });
  });

  it("never reads a bundled feed in development", () => {
    expect(
      resolveUpdateSource({
        runtimeFeedUrl: undefined,
        isPackaged: false,
        bundledFeedPath: "/workspace/apps/desktop/dist/app-update.yml",
        fileExists: always,
      }),
    ).toEqual({ kind: "none" });
  });

  it("reports no source when there is neither a built-in nor a runtime feed", () => {
    expect(
      resolveUpdateSource({ runtimeFeedUrl: undefined, isPackaged: true, bundledFeedPath: undefined, fileExists: always }),
    ).toEqual({ kind: "none" });
  });

  it("treats an empty runtime value as unset", () => {
    expect(
      resolveUpdateSource({
        runtimeFeedUrl: undefined,
        isPackaged: true,
        bundledFeedPath: "/opt/Terabot/resources/app-update.yml",
        fileExists: always,
      }),
    ).toEqual({ kind: "bundled" });
  });
});
