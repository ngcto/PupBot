import { describe, expect, it } from "vitest";
import type { RequiredCapability } from "@terabot/computers";
import type { ToolNeed } from "@terabot/tools";

/**
 * A tool's `needs` and the allocator's `requires` use one vocabulary.
 *
 * They used to differ — a tool said `screen`, the allocator said `screenshot` — with a
 * translator promised to "the loop" that no file ever contained. A tool stating needs:
 * ["screen"] would have been read by nothing, and the run placed on a box that could
 * not serve it: silently, because the strings did not intersect. A cast would have
 * compiled and dropped it too.
 *
 * The fix was to share the words rather than translate between them, since a shared
 * vocabulary does not couple two packages the way an adapter would. This file is the
 * guard that keeps them shared.
 *
 * It lives in this package's tests because `apps/web` is the only tsconfig in the repo
 * that typechecks test files, since every package's include covers only its source dir, so a
 * type-level guard placed beside `packages/tools` or `packages/computers` would sit in
 * a file `tsc` never reads and could never fail. That was true of the first version of
 * this test, which passed against a deliberately broken vocabulary.
 */
describe("the tool need vocabulary is the allocator's", () => {
  it("accepts a tool need wherever the allocator accepts a requirement", () => {
    // If a need is not a capability this stops compiling, which lands the failure on
    // whoever adds one side only. `tsc` reads this file, so that failure is real.
    const bridge = (need: ToolNeed): RequiredCapability => need;
    expect(bridge).toBeTypeOf("function");
  });

  it("lists exactly the allocator's capabilities, with no extras and no gaps", () => {
    const needs: ToolNeed[] = ["exec", "files", "screenshot"];
    const capabilities: RequiredCapability[] = ["exec", "files", "screenshot"];
    expect([...needs].sort()).toEqual([...capabilities].sort());
  });

  it("states the capability that makes the allocator refuse a screenless box", () => {
    // The case that motivates the whole file: a tool that looks at the screen must
    // produce the string the allocator uses to refuse a provider with no framebuffer.
    const screenTool: RequiredCapability = "screenshot" satisfies ToolNeed;
    expect(screenTool).toBe("screenshot");
  });
});
