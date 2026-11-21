import { describe, expect, it } from "vitest";
import { CuaDriver, createCuaFillSink, type CuaExecTarget } from "../src/index.ts";

/**
 * The sink the vault calls.
 *
 * `packages/vault` owns whether a value may be used; this package owns typing it.
 * What has to hold across that boundary: a stale target is refused by name, the
 * driver's own effect is passed through rather than flattened, and nothing in the
 * result can carry the value.
 */

const SECRET = "hunter2-do-not-leak";

function harness(answers: Record<string, unknown> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const target: CuaExecTarget = {
    async exec(command) {
      const tool = /call '([^']+)'/.exec(command)?.[1] ?? "unknown";
      const json = /printf '%s' '([^']*(?:'\\''[^']*)*)'/.exec(command)?.[1] ?? "{}";
      const args = JSON.parse(json.replace(/'\\''/g, "'")) as Record<string, unknown>;
      calls.push({ tool, args });
      const answer = answers[tool];
      return {
        stdout: JSON.stringify(answer ?? { status: "ok" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    },
  };
  return { driver: new CuaDriver(target, { session: "test" }), calls };
}

describe("the vault fill sink", () => {
  it("refuses a target read from an older snapshot instead of typing", async () => {
    const { driver, calls } = harness({
      get_window_state: {
        snapshot_id: "s0000000f",
        elements: [{ element_token: "s0000000f:3", role: "password text", value: "" }],
        tree_markdown: "- password text",
      },
    });
    const sink = createCuaFillSink({ driver, surface: { kind: "window", window: { pid: 100 } } });
    const outcome = await sink.fill({
      url: "https://example.com/login",
      target: { token: "s00000001:3", snapshotId: "s00000001" },
      field: "password",
      value: SECRET,
    });
    expect(outcome.effect).toBe("refused");
    expect(outcome.refusalCode).toBe("stale_element_token");
    // Nothing was typed: the only call is the read that found the staleness.
    expect(calls.map((entry) => entry.tool)).not.toContain("set_value");
    expect(calls.map((entry) => entry.tool)).not.toContain("type_text");
    // And the value is nowhere in what came back.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("fills a window target from the snapshot the caller saw", async () => {
    const { driver, calls } = harness({
      get_window_state: {
        snapshot_id: "s00000001",
        elements: [{ element_token: "s00000001:3", role: "password text", value: "", frame: { x: 4, y: 5, w: 100, h: 20 } }],
        tree_markdown: "- password text",
      },
      set_value: { effect: "confirmed", verified: true },
    });
    const sink = createCuaFillSink({ driver, surface: { kind: "window", window: { pid: 100 } } });
    const outcome = await sink.fill({
      url: "https://example.com/login",
      target: { token: "s00000001:3", snapshotId: "s00000001" },
      field: "password",
      value: SECRET,
    });
    expect(calls.map((entry) => entry.tool)).toContain("set_value");
    // The driver's effect is passed through, not flattened into "done".
    expect(outcome.effect).toBe("confirmed");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    // `landed` is absent here because the read-back saw no value; that is the
    // honest answer and it must not become `verified`.
    expect(outcome.verified).toBe(false);
  });

  it("passes a driver refusal's code through rather than inventing one", async () => {
    const { driver } = harness({
      get_window_state: {
        snapshot_id: "s00000002",
        elements: [{ element_token: "s00000002:9", role: "password text", value: "" }],
        tree_markdown: "- password text",
      },
    });
    // The driver refuses the write itself: a code from its own vocabulary.
    const refusing: CuaExecTarget = {
      async exec(command) {
        if (/call 'set_value'/.test(command)) {
          return {
            stdout: JSON.stringify({
              error: { code: "background_unavailable", message: "no background input for this window" },
            }),
            stderr: "",
            exitCode: 1,
            timedOut: false,
          };
        }
        return {
          stdout: JSON.stringify({
            snapshot_id: "s00000002",
            elements: [{ element_token: "s00000002:9", role: "password text", value: "" }],
            tree_markdown: "- password text",
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    const sink = createCuaFillSink({
      driver: new CuaDriver(refusing, { session: "test" }),
      surface: { kind: "window", window: { pid: 100 } },
    });
    const outcome = await sink.fill({
      url: "https://example.com/login",
      target: { token: "s00000002:9", snapshotId: "s00000002" },
      field: "password",
      value: SECRET,
    });
    expect(outcome.refusalCode).toBe("background_unavailable");
    expect(outcome.verified).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    void driver;
  });

  it("never reports an unknown driver effect as success", async () => {
    // The window keeps showing an empty field, so the fill escalates and the
    // second read-back is what decides — the unknown effect must not leak into
    // either arm as success.
    const { driver } = harness({
      get_window_state: {
        snapshot_id: "s00000003",
        elements: [{ element_token: "s00000003:1", role: "password text", value: "", frame: { x: 1, y: 2, w: 50, h: 10 } }],
        tree_markdown: "- password text",
      },
      set_value: { effect: "something-new-from-the-driver", verified: false },
      type_text: { effect: "something-new-from-the-driver", verified: false },
    });
    const sink = createCuaFillSink({ driver, surface: { kind: "window", window: { pid: 100 } } });
    const outcome = await sink.fill({
      url: "https://example.com/login",
      target: { token: "s00000003:1", snapshotId: "s00000003" },
      field: "password",
      value: SECRET,
    });
    // A driver answer this package cannot classify is never reported as done: a
    // value the field may not hold must not reach the vault as "confirmed".
    expect(outcome.effect).toBe("unverifiable");
    expect(outcome.effect).not.toBe("confirmed");
  });
});
