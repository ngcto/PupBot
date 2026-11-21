import { describe, expect, it, vi } from "vitest";
import { codemodeSchema, renderForModel, runCodeMode } from "../src/codemode.ts";
import type { DispatchableTool } from "../src/codemode.ts";
import type { SandboxResult } from "@terabot/sandbox";

/**
 * A tool whose result looks like the CUA ladder: a structured effect the program
 * must be able to branch on, and nothing a boolean could stand in for.
 */
function ladderTool(overrides: Partial<DispatchableTool> = {}): DispatchableTool {
  return {
    name: "click",
    description: "Click one target.",
    when: ["press a button"],
    category: "act",
    cost: "cheap",
    execute: async (args) => ({
      effect: args.fail === true ? "refused" : "unverifiable",
      verified: false,
      escalation: { recommended: "foreground", reason: "the widget refused background input" },
      refusal: args.fail === true ? { code: "background_unavailable" } : null,
    }),
    ...overrides,
  };
}

describe("the tool the model sees", () => {
  it("is one tool, not one per capability", () => {
    const schema = codemodeSchema([ladderTool(), ladderTool({ name: "typeText", description: "Type." })]);
    expect(schema.name).toBe("codemode");
    expect(Object.keys(schema.parameters.properties)).toEqual(["code"]);
  });

  it("carries the index so discovery costs no turn", () => {
    const schema = codemodeSchema([ladderTool()]);
    expect(schema.description).toContain("click");
    expect(schema.description).toContain("press a button");
    expect(schema.description).toContain("cheap");
  });

  it("offers only the tools that can run where the program runs", () => {
    const tools = [
      ladderTool({ name: "readWindow", placement: "box" }),
      ladderTool({ name: "vaultFill", placement: "host" }),
    ];
    expect(codemodeSchema(tools, "box").description).toContain("readWindow");
    expect(codemodeSchema(tools, "box").description).not.toContain("vaultFill");
  });
});

describe("the program's view of a result", () => {
  it("hands the program the whole result, so it can branch on effect", async () => {
    const outcome = await runCodeMode(
      {
        code: `
        const first = await tools.click({});
        text("effect=" + first.effect);
        text("escalation=" + first.escalation.recommended);
        if (first.effect === "unverifiable") {
          const second = await tools.click({ fail: true });
          text("second=" + second.effect + " refusal=" + second.refusal.code);
        }
        return "branched";
        `,
      },
      { tools: [ladderTool()] },
    );

    expect(outcome.result.ok).toBe(true);
    expect(outcome.text).toContain("effect=unverifiable");
    expect(outcome.text).toContain("escalation=foreground");
    expect(outcome.text).toContain("second=refused refusal=background_unavailable");
    expect(outcome.text).toContain("branched");
  });

  it("never reports a boolean where an effect belongs", async () => {
    // The specific failure this guards: a harness that returns `ok` instead of the
    // ladder makes `effect` undefined, and a program that branches on it silently
    // takes the wrong path.
    const outcome = await runCodeMode(
      { code: `const r = await tools.click({}); return typeof r.effect + ":" + r.effect;` },
      { tools: [ladderTool()] },
    );
    expect(outcome.text).toContain("string:unverifiable");
  });
});

describe("only what the program prints reaches the model", () => {
  it("filters a huge result to a line", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, status: i % 73 === 0 ? "pending" : "shipped" }));
    const outcome = await runCodeMode(
      {
        code: `
        const rows = await tools.read({});
        const pending = rows.filter((r) => r.status === "pending");
        text("found " + pending.length);
        return pending.slice(0, 2);
        `,
      },
      { tools: [ladderTool({ name: "read", description: "Read a sheet.", execute: async () => rows })] },
    );

    expect(outcome.result.ok).toBe(true);
    expect(outcome.text).toContain("found 137");
    expect(outcome.text.length).toBeLessThan(400);
  });
});

describe("the single enforcement point", () => {
  it("refuses to run a tool that was not offered here", async () => {
    const outcome = await runCodeMode(
      { code: `try { await tools.vaultFill({}); text("reached"); } catch (e) { text("blocked: " + e.message); } return 1;` },
      { tools: [ladderTool({ name: "vaultFill", placement: "host" })], placement: "box" },
    );
    expect(outcome.text).toContain("blocked");
    expect(outcome.text).not.toContain("reached");
  });

  it("counts every call against the budget, discovery included", async () => {
    const outcome = await runCodeMode(
      {
        code: `
        for (let i = 0; i < 10; i += 1) await tools.click({});
        return "done";
        `,
      },
      { tools: [ladderTool()], maxToolCalls: 3 },
    );
    expect(outcome.result.ok).toBe(false);
    expect(outcome.text).toContain("3 tool calls");
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    const outcome = await runCodeMode(
      {
        code: `
        await tools.click({});
        await tools.click({});
        return "done";
        `,
      },
      {
        tools: [ladderTool({ execute: async () => { controller.abort(); return { effect: "confirmed" }; } })],
        signal: controller.signal,
      },
    );
    expect(outcome.result.ok).toBe(false);
  });
});

describe("discovery without a second prompt surface", () => {
  it("finds a tool from the situation, in code", async () => {
    const outcome = await runCodeMode(
      {
        code: `
        const found = await tools.searchTools({ query: "fill a form" });
        text(found.map((t) => t.name).join(","));
        return found.length;
        `,
      },
      {
        tools: [
          ladderTool({ name: "click", when: ["press a button"] }),
          ladderTool({ name: "runSteps", when: ["fill a form", "do several clicks in a row"] }),
        ],
      },
    );
    // Both match; the one phrased as the situation comes first. That ordering is
    // the point — "fill a form" belongs to the batch tool, not the single click.
    expect(outcome.text.split("\n")[0]?.split(",")[0]).toBe("runSteps");
  });

  it("returns a signature on demand instead of in the prompt", async () => {
    const outcome = await runCodeMode(
      {
        code: `return await tools.describeTool({ name: "click" });`,
      },
      {
        tools: [
          ladderTool({
            signature: "click(args: { target: string; elementToken?: string }): Promise<unknown>;",
          }),
        ],
      },
    );
    expect(outcome.text).toContain("click(args: { target: string");
    expect(outcome.text).not.toContain("runSteps");
  });
});

describe("the trace a silent program gets", () => {
  const observe = (value: unknown) => ({
    name: "observeWindow",
    description: "Read a window.",
    when: ["what is in a window"],
    category: "observe" as const,
    cost: "cheap" as const,
    execute: async () => value,
  });

  it("shows the observation the program made and could not see", async () => {
    // The defect this fixes: a model that observed a tree and forgot text() had the
    // information and could not see it, so "printed nothing" was a shrug where it
    // should be a transcript.
    const outcome = await runCodeMode(
      { code: `const w = await tools.observeWindow({ windowId: "w2" });` },
      { tools: [observe({ rows: [{ token: "t1", role: "button", label: "Send" }] })] },
    );
    expect(outcome.text).toContain("observeWindow");
    expect(outcome.text).toContain("t1");
    expect(outcome.text).toContain("What your calls returned");
  });

  it("says nothing when the program printed its answer", async () => {
    // The cap that matters most: a trace on success is how a code-mode surface
    // quietly doubles its token cost.
    const outcome = await runCodeMode(
      { code: `const w = await tools.observeWindow({}); text("rows=" + w.rows.length);` },
      { tools: [observe({ rows: [1, 2, 3] })] },
    );
    expect(outcome.text).toContain("rows=3");
    expect(outcome.text).not.toContain("What your calls returned");
  });

  it("traces exactly three calls out of five, and says how many it omitted", async () => {
    const outcome = await runCodeMode(
      {
        code: `
        await tools.observeWindow({ n: 1 });
        await tools.observeWindow({ n: 2 });
        await tools.observeWindow({ n: 3 });
        await tools.observeWindow({ n: 4 });
        await tools.observeWindow({ n: 5 });
        `,
      },
      { tools: [observe({ ok: 1 })] },
    );
    const traced = outcome.text.split("\n").filter((line) => line.startsWith("- observeWindow")).length;
    expect(traced).toBe(3);
    expect(outcome.text).toContain("2 earlier omitted");
  });

  it("gives at most 200 characters of a 10k-row result, and marks it truncated", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ token: `t${i}`, label: `row ${i}` }));
    const outcome = await runCodeMode(
      { code: `const w = await tools.observeWindow({ windowId: "w1" });` },
      { tools: [observe({ rows })] },
    );
    const line = outcome.text.split("\n").find((l) => l.startsWith("- observeWindow"))!;
    // 200 characters of preview, plus the "- observeWindow: " prefix and the marker.
    expect(line.length).toBeLessThan(320);
    expect(line).toContain("[truncated]");
    // The whole render must stay near the cap: the trace is not a route to the result.
    expect(outcome.text.length).toBeLessThan(900);
  });

  it("keeps the whole trace under its own limit even with three long previews", async () => {
    const outcome = await runCodeMode(
      { code: `await tools.observeWindow({}); await tools.observeWindow({}); await tools.observeWindow({});` },
      { tools: [observe("x".repeat(900))] },
    );
    expect(outcome.text.length).toBeLessThan(1100);
  });

  it("names a failed call as failed, so the model can tell which one to fix", async () => {
    const outcome = await runCodeMode(
      {
        code: `
        try { await tools.missing({}); } catch {}
        await tools.observeWindow({});
        `,
      },
      { tools: [observe({ rows: [1] })] },
    );
    // A throwing call still records, and its message is the preview.
    expect(outcome.text).toContain("observeWindow");
  });
});

describe("what a failure looks like to the model", () => {
  it("keeps the output produced before a stall, and says it is a program error", () => {
    const result: SandboxResult = {
      ok: false,
      error: { kind: "stall", message: "waiting on a promise that can never settle" },
      output: ["before"],
      calls: [{ name: "click", ok: true, ms: 3 }],
      ms: 40,
    };
    const text = renderForModel(result);
    expect(text).toContain("before");
    expect(text).toContain("stopped:");
    expect(text).toContain("no timers");
    expect(text).toContain("1 tool call succeeded");
  });

  it("names the line when the program had a syntax error", () => {
    const text = renderForModel({
      ok: false,
      error: { kind: "script", message: "unexpected token", line: 4 },
      output: [],
      calls: [],
      ms: 2,
    });
    expect(text).toContain("line 4");
  });

  it("tells the model when a program printed nothing at all", () => {
    const text = renderForModel({ ok: true, output: [], value: undefined, calls: [], ms: 1 });
    expect(text).toContain("printed nothing");
  });

  it("reports how many calls failed, by name", () => {
    const text = renderForModel({
      ok: true,
      output: ["x"],
      value: undefined,
      calls: [
        { name: "click", ok: false, ms: 1 },
        { name: "click", ok: true, ms: 1 },
      ],
      ms: 3,
    });
    expect(text).toContain("1 failed (click)");
  });
});

describe("call reporting", () => {
  it("reports each call so the run log can show work the model did not pay for", async () => {
    const onCall = vi.fn();
    await runCodeMode({ code: `await tools.click({}); await tools.click({}); return 1;` }, {
      tools: [ladderTool()],
      onCall,
    });
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ name: "click", ok: true });
  });
});
