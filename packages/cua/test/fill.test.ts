import { describe, expect, it } from "vitest";
import {
  CuaDriver,
  fillSecret,
  isStaleTarget,
  type CuaExecTarget,
  type CuaObservation,
} from "../src/index.ts";

/**
 * The fill path is where a mistake is silent and a real harm: a password typed
 * into the wrong field, or into a field that moved between the observation and
 * the write. These tests exist to make that failure loud.
 */

/** Records the driver calls a fill makes, and answers them. */
function harness(answers: Record<string, unknown> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const target: CuaExecTarget = {
    async exec(command) {
      // The tool name is the first positional after `call`.
      const tool = /call '([^']+)'/.exec(command)?.[1] ?? "unknown";
      const json = /printf '%s' '([^']*(?:'\\''[^']*)*)'/.exec(command)?.[1] ?? "{}";
      const args = JSON.parse(json.replace(/'\\''/g, "'")) as Record<string, unknown>;
      calls.push({ tool, args });

      const answer = answers[tool];
      if (answer) {
        return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: JSON.stringify({ status: "ok" }), stderr: "", exitCode: 0, timedOut: false };
    },
  };
  return { driver: new CuaDriver(target, { session: "test" }), calls };
}

function observation(overrides: Partial<CuaObservation> = {}): CuaObservation {
  return {
    kind: "window",
    pid: 100,
    windowId: 200,
    snapshotId: "s00000005",
    elements: [
      { token: "s00000005:12", role: "text field", label: "Password", actions: ["edit"] },
      { token: "s00000005:3", role: "text field", label: "Search", actions: ["edit"] },
    ],
    outline: "- text field \"Password\"",
    degraded: false,
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

describe("a fill targets an element from the observation that produced it", () => {
  it("writes the value with setValue, which needs no focus and no keystrokes", async () => {
    const { driver, calls } = harness({
      get_window_state: {
        snapshot_id: "s00000006",
        elements: [{ element_token: "s00000006:12", role: "text field", label: "Password", value: "hunter2" }],
        tree_markdown: "- text field \"Password\"",
      },
    });

    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      value: "hunter2",
    });

    const write = calls.find((call) => call.tool === "set_value");
    expect(write?.args.element_token).toBe("s00000005:12");
    expect(write?.args.value).toBe("hunter2");
    // Verified by a re-read, so the caller knows the field shows it.
    expect(result.landed).toBe(true);
    expect(result.message).not.toContain("hunter2");
  });

  it("refuses a token from a different observation instead of re-aiming it", async () => {
    const { driver, calls } = harness();
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: {
        kind: "element",
        observation: observation({ snapshotId: "s00000009" }),
        elementToken: "s00000005:12",
      },
      value: "hunter2",
    });

    expect(result.effect).toBe("refused");
    expect(result.refusal?.code).toBe("stale_element_token");
    expect(isStaleTarget(result)).toBe(true);
    // Nothing was written: a stale token must never become a guess.
    expect(calls.some((call) => call.tool === "set_value")).toBe(false);
    // And the secret never appears in what the caller is told.
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("refuses a token the observation does not contain", async () => {
    const { driver, calls } = harness();
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:99" },
      value: "hunter2",
    });
    expect(result.refusal?.code).toBe("stale_element_token");
    expect(calls.some((call) => call.tool === "set_value")).toBe(false);
  });

  it("refuses when the target is not the kind of element the caller expected", async () => {
    // The observation says row 3 is a text field, but the caller asserts a
    // button: something is wrong with their aim, and typing is the harm.
    const { driver, calls } = harness();
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: {
        kind: "element",
        observation: observation(),
        elementToken: "s00000005:3",
        expect: { role: "push button" },
      },
      value: "hunter2",
    });
    expect(result.refusal?.code).toBe("wrong_target");
    expect(calls.some((call) => call.tool === "set_value")).toBe(false);
  });

  it("refuses when the label does not match what the caller expected", async () => {
    const { driver } = harness();
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: {
        kind: "element",
        observation: observation(),
        elementToken: "s00000005:3",
        expect: { labelIncludes: "Password" },
      },
      value: "hunter2",
    });
    expect(result.refusal?.code).toBe("wrong_target");
  });

  it("refuses a fill with no value instead of forwarding undefined to the driver", async () => {
    const { driver, calls } = harness();
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      // @ts-expect-error a caller that forgot the value is exactly the bug this guards.
      value: undefined,
    });
    expect(result.effect).toBe("refused");
    expect(result.message).toContain("No value was given");
    // Nothing reached the driver, so no unrelated parse error can stand in for it.
    expect(calls).toHaveLength(0);
  });

  it("escalates to real keystrokes when the direct write does not show up", async () => {
    // MEASURED on a box: a GTK entry ignores `set_value` while the driver still
    // answers `confirmed`. A handleType: the only honest answer is a second
    // rung, and the read-back decides the result.
    const { driver, calls } = harness({
      set_value: { effect: "confirmed", verified: true },
      get_window_state: {
        snapshot_id: "s00000007",
        elements: [
          { element_token: "s00000007:12", role: "text field", label: "Password", value: "", frame: { x: 10, y: 20, w: 200, h: 30 } },
        ],
        tree_markdown: "- text field \"Password\"",
      },
    });
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      value: "hunter2",
    });
    // Two rungs were taken: the direct write, then a click and keystrokes.
    const tools = calls.map((entry) => entry.tool);
    expect(tools).toContain("set_value");
    expect(tools).toContain("click");
    expect(tools).toContain("type_text");
    // The click was aimed at the element's own frame, in the foreground.
    const clicked = calls.find((entry) => entry.tool === "click")!;
    expect(clicked.args).toMatchObject({ x: 110, y: 35, delivery_mode: "foreground" });
    // The field still shows nothing, so the fill is not reported as landed.
    expect(result.landed).toBe(false);
    expect(result.message).toContain("does not show it");
  });

  it("does not describe an unverifiable fill as done", async () => {
    const { driver } = harness({ set_value: { effect: "unverifiable", verified: false } });
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      value: "hunter2",
      verify: false,
    });
    expect(result.effect).toBe("unverifiable");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("could not be confirmed");
    expect(result.landed).toBeUndefined();
  });
});

describe("a masked field is still a field that holds the value", () => {
  it("reads a password mask as landed when it is the right length", async () => {
    // MEASURED: a password input reports a mask, not its value —
    // "•••••••••••••••••••••" for a 21-character fill. Comparing against the
    // value would report every real password fill as a failure.
    const { driver } = harness({
      set_value: { effect: "confirmed", verified: true },
      get_window_state: {
        snapshot_id: "s00000008",
        elements: [
          { element_token: "s00000008:12", role: "text field", label: "Password", value: "••••••" },
        ],
        tree_markdown: "- text field \"Password\"",
      },
    });
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      value: "hunter",
    });
    expect(result.landed).toBe(true);
    expect(result.message).toBe("The field now holds the value.");
  });

  it("does not read a mask of the wrong length as landed", async () => {
    const { driver } = harness({
      set_value: { effect: "confirmed", verified: true },
      get_window_state: {
        snapshot_id: "s00000008",
        elements: [{ element_token: "s00000008:12", role: "text field", label: "Password", value: "••••" }],
        tree_markdown: "-",
      },
    });
    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "element", observation: observation(), elementToken: "s00000005:12" },
      value: "hunter",
    });
    expect(result.landed).toBe(false);
  });
});

describe("a page fill targets a ref from the snapshot that produced it", () => {
  const pageSnapshot = (id: string, value: string | null) => ({
    status: "ok",
    outline: "- textbox \"Password\"",
    refs: [{ ref: "p1:4", role: "textbox", name: "Password", value, actions: ["type"] }],
    content_refs: [],
    snapshot: { id, complete: true, continuation: null },
    page: { url: "https://app.example.com/login", title: "Sign in" },
  });

  it("types into a typable ref when the snapshot still matches", async () => {
    let snapshots = 0;
    const calls: string[] = [];
    const target: CuaExecTarget = {
      async exec(command) {
        const tool = /call '([^']+)'/.exec(command)?.[1] ?? "unknown";
        calls.push(tool);
        if (tool === "browser_type") return { stdout: JSON.stringify({ effect: "unverifiable" }), stderr: "", exitCode: 0, timedOut: false };
        snapshots += 1;
        // First read: the snapshot the caller holds. Second: the read-back.
        const body = snapshots === 1 ? pageSnapshot("p9", null) : pageSnapshot("p9", "hunter2");
        return { stdout: JSON.stringify(body), stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const driver = new CuaDriver(target, { session: "test" });

    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "page", targetId: "bt-1", tabId: "tab-1", ref: "p1:4", snapshotId: "p9" },
      value: "hunter2",
    });

    expect(calls).toContain("browser_type");
    // The driver said unverifiable; the read-back is what answers "did it land".
    expect(result.verified).toBe(false);
    expect(result.landed).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("passes the driver's own staleness refusal through, and never retries blind", async () => {
    // A ref belongs to one snapshot. Re-snapshotting to validate it would kill
    // the very ref we are about to use (measured: the driver invalidates every
    // ref on a read), so the driver's `browser_ref_stale` is the guard — and a
    // stale target must never be re-aimed at whatever now sits at that ref.
    const calls: string[] = [];
    const target: CuaExecTarget = {
      async exec(command) {
        const tool = /call '([^']+)'/.exec(command)?.[1] ?? "unknown";
        calls.push(tool);
        if (tool === "browser_type") {
          return {
            stdout: JSON.stringify({
              effect: "refused",
              refusal: { code: "browser_ref_stale", message: "ref p1:4 belongs to a replaced snapshot" },
            }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        return { stdout: JSON.stringify(pageSnapshot("p10", null)), stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const driver = new CuaDriver(target, { session: "test" });

    const result = await fillSecret(driver, {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "page", targetId: "bt-1", tabId: "tab-1", ref: "p1:4", snapshotId: "p9" },
      value: "hunter2",
    });

    expect(result.effect).toBe("refused");
    expect(result.refusal?.code).toBe("browser_ref_stale");
    expect(isStaleTarget(result)).toBe(true);
    // Exactly one attempt: no second write against a guess.
    expect(calls.filter((tool) => tool === "browser_type")).toHaveLength(1);
    expect(result.message).toContain("Nothing was typed");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("fills the first typable ref when the caller has no ref of its own", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const target: CuaExecTarget = {
      async exec(command) {
        const tool = /call '([^']+)'/.exec(command)?.[1] ?? "unknown";
        if (tool === "browser_type") {
          const json = /printf '%s' '([^']*(?:'\\''[^']*)*)'/.exec(command)?.[1] ?? "{}";
          writes.push(JSON.parse(json.replace(/'\\''/g, "'")) as Record<string, unknown>);
          return { stdout: JSON.stringify({ effect: "unverifiable" }), stderr: "", exitCode: 0, timedOut: false };
        }
        return {
          stdout: JSON.stringify({
            status: "ok",
            outline: "- button \"Sign in\"\n- textbox \"Password\"",
            refs: [
              { ref: "p2:1", role: "button", name: "Sign in", value: null, actions: ["click"] },
              { ref: "p2:2", role: "textbox", name: "Password", value: null, actions: ["type"] },
            ],
            content_refs: [],
            snapshot: { id: "p2", complete: true, continuation: null },
            page: { url: "https://x", title: "Sign in" },
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    const result = await fillSecret(new CuaDriver(target), {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "page", targetId: "bt-1", tabId: "tab-1" },
      value: "hunter2",
      verify: false,
    });
    // The button is not typable, so the textbox is chosen — never the button.
    expect(writes[0]?.ref).toBe("p2:2");
    expect(result.effect).toBe("unverifiable");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("refuses when the tab has no typable ref at all", async () => {
    const target: CuaExecTarget = {
      async exec() {
        return {
          stdout: JSON.stringify({
            status: "ok",
            outline: "- button \"Sign in\"",
            refs: [{ ref: "p3:1", role: "button", name: "Sign in", value: null, actions: ["click"] }],
            content_refs: [],
            snapshot: { id: "p3", complete: true, continuation: null },
            page: { url: "https://x", title: "Sign in" },
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    const result = await fillSecret(new CuaDriver(target), {
      target: { pid: 100, windowId: 200 },
      fill: { kind: "page", targetId: "bt-1", tabId: "tab-1" },
      value: "hunter2",
    });
    expect(result.refusal?.code).toBe("browser_ref_stale");
    expect(result.message).toContain("nothing was typed");
  });
});
