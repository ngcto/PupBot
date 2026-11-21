import { describe, expect, it } from "vitest";
import {
  CuaDriver,
  readActionResult,
  readObservation,
  shellQuote,
  type CuaExecTarget,
} from "../src/index.ts";

/**
 * Payloads in this file are **recorded**, not imagined: they were captured from
 * cua-driver 0.55.0 on an Instabox box (Debian 13, X11/XFCE) while measuring the
 * integration. A fixture that drifts from the driver is worse than no fixture,
 * so each one is labelled with what produced it.
 */

/** Background click on a GTK table cell, refused on XFCE. Recorded. */
const REFUSED_BACKGROUND = {
  code: "background_unavailable",
  detail: "the requested target has no focus-free input backend; the remaining input route can only deliver to the globally focused widget",
  effect: "refused",
  escalation: {
    reason: 'background input is unavailable on this surface; retry this action with delivery_mode:"foreground".',
    recommended: "foreground",
  },
  hint: "No background route for this action. Try an element action, invoke_menu, a shortcut or the browser tools first.",
};

/** The same click retried in the foreground. Recorded. */
const CONFIRMED_FOREGROUND = {
  delivery: { mode: "foreground" },
  effect: "confirmed",
  evidence: [{ detail: "focus_after=target; closed: popup window 18874583", kind: "window_change" }],
  route: "global_input",
  summary: "Clicked element [31] (pid 3354) with a real pointer click (delivery_mode=foreground, focus_after=target)",
};

/** A token from a replaced snapshot. Recorded shape from the driver's refusal. */
const STALE_TOKEN = {
  refusal: {
    code: "stale_element_token",
    message: "element token s00000002:31 belongs to a replaced snapshot",
  },
  effect: "refused",
};

describe("the action ladder", () => {
  it("does not report a refused action as success, and names the rung to climb", () => {
    const result = readActionResult(REFUSED_BACKGROUND, 12);
    expect(result.ok).toBe(false);
    expect(result.effect).toBe("refused");
    expect(result.verified).toBe(false);
    expect(result.refusal?.code).toBe("background_unavailable");
    expect(result.escalation).toEqual({
      recommended: "foreground",
      reason: expect.stringContaining("foreground"),
    });
    // The hint is what tells a model there is another route at all.
    expect(result.refusal?.hint).toContain("element action");
  });

  it("reports a confirmed foreground click as ok and verified-by-observation", () => {
    const result = readActionResult(CONFIRMED_FOREGROUND, 40);
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("confirmed");
    expect(result.path ?? result.delivery?.mode).toBe("foreground");
    expect(result.evidence?.[0]?.kind).toBe("window_change");
  });

  it("treats unverifiable as delivered-but-not-done, never as success", () => {
    // Electron and web content echo writes they did not apply; the driver says
    // so, and a caller that reported this as done would be lying.
    const result = readActionResult({ effect: "unverifiable", path: "cgevent" }, 8);
    expect(result.ok).toBe(false);
    expect(result.effect).toBe("unverifiable");
    expect(result.verified).toBe(false);
  });

  it("surfaces a stale element token as re-observe, not as a broken element route", () => {
    const result = readActionResult(STALE_TOKEN, 5);
    expect(result.ok).toBe(false);
    expect(result.refusal?.code).toBe("stale_element_token");
    // No escalation: the fix is a fresh read of the same window, not another rung.
    expect(result.escalation).toBeUndefined();
  });

  it("ignores an escalation the driver does not actually recommend", () => {
    const result = readActionResult({ effect: "unverifiable", escalation: { recommended: "teleport" } }, 1);
    expect(result.escalation).toBeUndefined();
  });

  it("reads a partial batch as not-done even though nothing refused", () => {
    const result = readActionResult({ effect: "partial", summary: "2 of 3 steps applied" }, 60);
    expect(result.ok).toBe(false);
    expect(result.effect).toBe("partial");
  });
});

describe("observation", () => {
  it("keeps the tree, the snapshot id and the outline in one shape", () => {
    const observation = readObservation(
      {
        window_title: "Application Finder",
        app_name: "Xfce4-appfinder",
        snapshot_id: "s00000003",
        tree_markdown: "- table\n  - cell \"About Xfce\"",
        elements: [
          {
            element_token: "s00000003:31",
            role: "table cell",
            label: "About Xfce",
            actions: ["activate", "edit"],
            frame: { x: 394, y: 255, w: 532, h: 38 },
          },
          { role: "no token, so dropped" },
        ],
      },
      { kind: "window", pid: 3354, windowId: 18874376, durationMs: 11 },
    );

    expect(observation.snapshotId).toBe("s00000003");
    expect(observation.elements).toHaveLength(1);
    expect(observation.elements[0]?.token).toBe("s00000003:31");
    expect(observation.elements[0]?.frame).toEqual({ x: 394, y: 255, w: 532, h: 38 });
    expect(observation.title).toBe("Application Finder");
    expect(observation.degraded).toBe(false);
  });

  it("calls an empty tree degraded so the caller falls back to pixels in the same response", () => {
    const observation = readObservation({ snapshot_id: "s1", tree_markdown: "" }, { kind: "window", durationMs: 3 });
    expect(observation.degraded).toBe(true);
    expect(observation.elements).toEqual([]);
  });

  it("keeps a screenshot only when one was asked for", () => {
    // Recorded: the CLI returns the image inline at the top level, not as a
    // content block, so both shapes are accepted.
    const payload = {
      snapshot_id: "s1",
      tree_markdown: "-",
      screenshot_png_b64: "iVBORw0",
      screenshot_mime_type: "image/png",
      screenshot_width: 640,
      screenshot_height: 480,
    };
    expect(readObservation(payload, { kind: "window", durationMs: 1 }).screenshot).toBeUndefined();
    const withImage = readObservation(payload, { kind: "window", durationMs: 1, screenshot: true });
    expect(withImage.screenshot).toEqual({ data: "iVBORw0", mime: "image/png", width: 640, height: 480 });
    // The SDK/MCP content-block shape still parses.
    const blocks = readObservation(
      { snapshot_id: "s1", tree_markdown: "-", images: [{ data: "iVBORw0", mime_type: "image/png" }] },
      { kind: "window", durationMs: 1, screenshot: true },
    );
    expect(blocks.screenshot?.mime).toBe("image/png");
  });
});

describe("the driver transport", () => {
  it("sends JSON over stdin rather than as a quoted shell argument", async () => {
    const seen: string[] = [];
    const target: CuaExecTarget = {
      async exec(command) {
        seen.push(command);
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const driver = new CuaDriver(target, { socket: "/tmp/x.sock", session: "test" });
    await driver.call("click", { element_token: "s1:2", text: "it's a \"quote\"\nand a newline" });

    const command = seen[0] ?? "";
    expect(command).toContain("printf '%s'");
    expect(command).toContain("|");
    expect(command).toContain("call 'click'");
    // The session label rides on every call so a bot's state is one session.
    expect(command).toContain('"session":"test"');
    // The quote in the payload is escaped, not left to close the shell word.
    expect(shellQuote("it's a")).toBe(`'it'\\''s a'`);
  });

  it("turns a missing binary into a clear refusal a product surface can show", async () => {
    const target: CuaExecTarget = {
      async exec() {
        return { stdout: "", stderr: "bash: cua-driver: command not found", exitCode: 127, timedOut: false };
      },
    };
    const reply = await new CuaDriver(target).call("list_windows");
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.code).toBe("driver_unavailable");
      expect(reply.message).toContain("not installed");
    }
  });

  it("keeps a refusal as a refusal, because the CLI exits non-zero for one too", async () => {
    const target: CuaExecTarget = {
      async exec() {
        return { stdout: JSON.stringify(REFUSED_BACKGROUND), stderr: "", exitCode: 1, timedOut: false };
      },
    };
    const reply = await new CuaDriver(target).call("click", {});
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(readActionResult(reply.value, 1).refusal?.code).toBe("background_unavailable");
    }
  });

  it("reports a timeout as a timeout, not as a refusal", async () => {
    const target: CuaExecTarget = {
      async exec() {
        return { stdout: "", stderr: "", exitCode: -1, timedOut: true };
      },
    };
    const reply = await new CuaDriver(target).call("get_window_state", {});
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.code).toBe("driver_timeout");
  });

  it("says the daemon is unreachable instead of claiming the action worked", async () => {
    const target: CuaExecTarget = {
      async exec(command) {
        if (command.includes("--version")) return { stdout: "cua-driver 0.55.0", stderr: "", exitCode: 0, timedOut: false };
        return { stdout: "", stderr: "Error: connect: socket refused", exitCode: 1, timedOut: false };
      },
    };
    const driver = new CuaDriver(target, { socket: "/tmp/none.sock" });
    const reply = await driver.call("list_windows");
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toContain("daemon is not reachable");
  });
});

describe("ensureReady", () => {
  it("starts a daemon when one is missing and reports accessibility separately", async () => {
    const commands: string[] = [];
    const target: CuaExecTarget = {
      async exec(command) {
        commands.push(command);
        if (command.includes("--version")) return { stdout: "0.55.0", stderr: "", exitCode: 0, timedOut: false };
        if (command.includes("serve --socket")) return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        if (command.includes("get_session")) {
          // First call: no daemon. After the daemon starts: a session.
          return commands.filter((line) => line.includes("serve --socket")).length > 0
            ? { stdout: '{"sessions":[]}', stderr: "", exitCode: 0, timedOut: false }
            : { stdout: "", stderr: "socket refused", exitCode: 1, timedOut: false };
        }
        if (command.includes("health_report")) {
          return { stdout: '{"accessibility":{"status":"ok"}}', stderr: "", exitCode: 0, timedOut: false };
        }
        return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const readiness = await new CuaDriver(target).ensureReady();
    expect(readiness.ok).toBe(true);
    expect(readiness.daemonStarted).toBe(true);
    expect(readiness.accessibility).toBe(true);
  });

  it("distinguishes 'no driver installed' from 'daemon would not start'", async () => {
    const target: CuaExecTarget = {
      async exec(command) {
        if (command.includes("--version")) return { stdout: "", stderr: "not found", exitCode: 127, timedOut: false };
        return { stdout: "", stderr: "socket refused", exitCode: 1, timedOut: false };
      },
    };
    const readiness = await new CuaDriver(target).ensureReady();
    expect(readiness.ok).toBe(false);
    expect(readiness.installed).toBe(false);
    expect(readiness.reason).toContain("not installed");
    expect(readiness.reason).toContain("cua.ai/driver/install.sh");
  });
});
