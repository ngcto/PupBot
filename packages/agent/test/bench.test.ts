import { describe, expect, it } from "vitest";
import { buildArm } from "../src/bench/arms.ts";
import { renderTable } from "../src/bench/runner.ts";
import { TASKS, task10Expected } from "../src/bench/tasks.ts";
import { armA, armB, armC, availableToolNames, STALE_TOKEN } from "../src/bench/arms.ts";
import { treeFor, WINDOWS } from "../src/bench/fixtures.ts";

/**
 * The benchmark's own correctness, tested before any measurement.
 *
 * A benchmark that runs is not the same as a benchmark that measures the right thing.
 * These tests pin the properties the table would otherwise assume: that the arms
 * differ only in their surface, that the fixtures are deterministic, that arm C
 * really can filter a large tree, and that the validators reject wrong answers
 * instead of passing everything.
 */

describe("the fixtures", () => {
  it("builds the same tree twice", () => {
    const a = treeFor(1, 24);
    const b = treeFor(1, 24);
    expect(a).toEqual(b);
    expect(a).toHaveLength(24);
  });

  it("contains exactly one Approve invoice row, at a stable token", () => {
    const first = treeFor(1, 24).filter((r) => r.label === "Approve invoice");
    const second = treeFor(1, 24).filter((r) => r.label === "Approve invoice");
    expect(first).toHaveLength(1);
    expect(first[0]!.token).toBe(second[0]!.token);
  });

  it("has some rows actionable and some not, so filtering means something", () => {
    const rows = treeFor(1, 24);
    expect(rows.some((r) => r.actionable)).toBe(true);
    expect(rows.some((r) => !r.actionable)).toBe(true);
  });
});

describe("the arms differ only in their surface", () => {
  it("gives arm A no tools at all", () => {
    expect(availableToolNames("a")).toEqual([]);
    expect(armA().tools).toHaveLength(0);
  });

  it("gives arm B the 26 as individual tools", () => {
    expect(availableToolNames("b")).toHaveLength(26);
    expect(armB().tools).toHaveLength(26);
  });

  it("gives arm C one tool whose input is a program", () => {
    const build = armC();
    expect(build.tools).toHaveLength(1);
    expect(build.tools[0]!.schema.name).toBe("codemode");
    expect(Object.keys((build.tools[0]!.schema.parameters as { properties: object }).properties)).toEqual(["code"]);
  });

  it("handles the same capability in both tool-using arms", () => {
    // Every tool B offers must be reachable from C's program, or C is a smaller arm
    // and the comparison is not between surfaces but between capabilities.
    const bNames = armB().tools.map((t) => t.schema.name).sort();
    const descriptors = armC().tools[0]!.schema.description as string;
    for (const name of bNames) expect(descriptors).toContain(name);
  });
});

describe("arm C's single tool really runs a program", () => {
  it("returns only what the program printed", async () => {
    const build = armC();
    const tool = build.tools[0]!;
    const outcome = await tool.handler(
      { code: `const w = await tools.listWindows({}); text(w.length + " windows"); return w[0].app;` },
      { workspaceId: "w", botId: "b", conversationId: "c", runId: "r", signal: new AbortController().signal, emit: async () => 0 },
    );
    expect(outcome.result).toContain("3 windows");
    expect(outcome.result).toContain("Invoices");
    // The whole result must not be there: that is the claim.
    expect(outcome.result).not.toContain("snapshotId");
  });

  it("filters task 10's tree to two facts without shipping the rows", async () => {
    const build = armC();
    const tool = build.tools[0]!;
    const expected = task10Expected();
    const outcome = await tool.handler(
      {
        code: `
        const w = await tools.observeWindow({ windowId: "w1" });
        const actionable = w.rows.filter((r) => r.actionable);
        const target = w.rows.find((r) => r.label === "Approve invoice");
        text(actionable.length + " actionable, token " + target.token);
        return target.token;
        `,
      },
      { workspaceId: "w", botId: "b", conversationId: "c", runId: "r", signal: new AbortController().signal, emit: async () => 0 },
    );
    expect(outcome.result).toContain(String(expected.actionable));
    expect(outcome.result).toContain(expected.targetToken);
    // A 24-row tree's rows must not appear: the filter is the point of the task.
    expect(outcome.result.length).toBeLessThan(200);
  });

  it("hands the program a refusal it can branch on", async () => {
    const build = armC();
    // Task 9's fixture: the first click on this token refuses, so the program has a
    // real refusal to branch on rather than a boolean it has to interpret.
    build.world.staleToken = "t1x7";
    const outcome = await build.tools[0]!.handler(
      {
        code: `
        const first = await tools.click({ token: "t1x7" });
        text("first=" + first.effect);
        if (first.effect === "refused") {
          text("code=" + first.refusal.code);
          text("escalate=" + first.escalation.recommended);
          const second = await tools.click({ token: "t2ab" });
          text("second=" + second.effect);
        }
        `,
      },
      { workspaceId: "w", botId: "b", conversationId: "c", runId: "r", signal: new AbortController().signal, emit: async () => 0 },
    );
    expect(outcome.result).toContain("first=refused");
    expect(outcome.result).toContain("code=stale_token");
    expect(outcome.result).toContain("escalate=observe");
    expect(outcome.result).toContain("second=confirmed");
  });
});

describe("the validators", () => {
  const task = (id: number) => TASKS.find((t) => t.id === id)!;

  it("rejects an answer that names no app in task 1", () => {
    const build = armB();
    build.log.push({ name: "listApps", input: {} });
    expect(task(1).validate("I could not tell you.", build).ok).toBe(false);
    expect(task(1).validate("Running: Invoices, Mail, Editor.", build).ok).toBe(true);
  });

  it("rejects task 4 unless the token was actually clicked", () => {
    const build = armB();
    expect(task(4).validate("I clicked t1ab", build).ok).toBe(false);
    build.log.push({ name: "click", input: { token: "t1ab" }, effect: "confirmed" });
    expect(task(4).validate("I clicked t1ab", build).ok).toBe(true);
  });

  it("rejects task 10 for a token-shaped guess", () => {
    const build = armB();
    build.log.push({ name: "observeWindow", input: { windowId: "w1" } });
    expect(task(10).validate("4 actionable, token tzzzz", build).ok).toBe(false);
    const expected = task10Expected();
    expect(task(10).validate(`${expected.actionable} actionable, token ${expected.targetToken}`, build).ok).toBe(true);
  });

  it("arms the refusal task 9 depends on, in both tool arms", () => {
    // Caught by the first real measurement run: without this the fixture never
    // refuses, so task 9 asked a model to recover from something that cannot happen
    // and read as a failure of the arm.
    for (const arm of [armB(), armC()]) expect(arm.world.staleToken).toBe(STALE_TOKEN);
    const click = armB().tools.find((t) => t.schema.name === "click")!;
    return click.handler({ token: STALE_TOKEN }).then((outcome) => {
      expect(outcome.result).toContain("refused");
    });
  });

  it("rejects task 9 when the refusal was never acknowledged", () => {
    const build = armB();
    build.log.push({ name: "click", input: { token: "t1x7" }, effect: "refused" });
    build.log.push({ name: "click", input: { token: "t2ab" }, effect: "confirmed" });
    expect(task(9).validate("Done, clicked it.", build).ok).toBe(false);
    expect(task(9).validate("The token was stale, so I re-read the window and clicked t2ab.", build).ok).toBe(true);
  });

  it("rejects task 8 if a screenshot was taken", () => {
    const build = armB();
    build.world.values.set("ref1", "quarterly");
    build.log.push({ name: "screenshot", input: {} });
    expect(task(8).validate("quarterly is in the field", build).ok).toBe(false);
  });
});

describe("task attemptability", () => {
  it("marks arm A unable to attempt every task that needs a tool", () => {
    const toolTasks = TASKS.filter((t) => t.needs.length > 0);
    for (const t of toolTasks) {
      expect(t.attemptable("a")).toBe(false);
      expect(t.attemptable("b")).toBe(true);
      expect(t.attemptable("c")).toBe(true);
    }
  });

  it("gives every arm at least one task it can attempt", () => {
    // Task 11 exists so arm A is measured rather than n/a in every cell, and so code
    // mode's index cost shows up on a task that needs no tools.
    expect(TASKS.some((t) => t.attemptable("a"))).toBe(true);
    for (const arm of ["a", "b", "c"] as const) {
      expect(TASKS.filter((t) => t.attemptable(arm)).length).toBeGreaterThan(0);
    }
  });

  it("has eleven tasks, numbered in order", () => {
    expect(TASKS).toHaveLength(11);
    expect(TASKS.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("names only tools that exist in the fixture set", () => {
    const known = new Set(Object.keys(armB().tools.reduce((acc, t) => ({ ...acc, [t.schema.name]: true }), {})));
    for (const t of TASKS) for (const need of t.needs) expect(known.has(need)).toBe(true);
  });

  it("keeps task 10 aimed at a window the fixture really has", () => {
    expect(WINDOWS.some((w) => w.id === "w1")).toBe(true);
  });
});

describe("the table", () => {
  it("reports the median of the reps, not the fastest", () => {
    // Three reps where one is an outlier: the fastest would flatter whichever arm
    // varies most, and code mode is the arm most likely to.
    const base = { attemptable: true, ok: true, why: "", answer: "", outputTokens: 0, wallMsModel: 0 };
    const table = renderTable(
      [
        { ...base, arm: "c", taskId: 1, turns: 10, inputTokens: 1000, wallMsInclusive: 100 },
        { ...base, arm: "c", taskId: 1, turns: 4, inputTokens: 400, wallMsInclusive: 40 },
        { ...base, arm: "c", taskId: 1, turns: 6, inputTokens: 600, wallMsInclusive: 60 },
      ],
      3,
    );
    expect(table).toContain("| 6 | 600 |");
    expect(table).not.toContain("| 4 | 400 |");
  });

  it("names the turn unit, so nobody reads it as tool calls", () => {
    expect(renderTable([], 1)).toContain("Turns (model round trips)");
  });
});

describe("buildArm", () => {
  it("builds each arm fresh, so one task cannot leak state into the next", () => {
    const first = buildArm("b");
    first.world.clicked.push("t1");
    const second = buildArm("b");
    expect(second.world.clicked).toHaveLength(0);
  });
});
