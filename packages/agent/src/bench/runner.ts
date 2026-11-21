/**
 * The benchmark runner: one real `executeRun` per task per arm.
 *
 * Why the real harness and not a driver: a driver that called the three surfaces
 * directly would be honest about tokens and dishonest about behaviour, and the
 * behaviour is the point. So every run goes through `executeRun` — the same loop, the
 * same registry, the same `MAX_TOOL_STEPS` — and the arms differ only in the `tools`
 * array handed to it.
 *
 * Token counting reads the provider's own `usage` events, which is what an account is
 * billed for. `count_tokens` answers a different question (the fixed cost of a
 * surface) and is measured in `reports/tera-81-measurements/`.
 */

import { performance } from "node:perf_hooks";
import { executeRun } from "../run.ts";
import type { ModelEvent, ModelGateway, StreamRequest } from "@terabot/providers";
import type { Database } from "@terabot/db";
import type { Arm, ArmBuild } from "./arms.ts";
import type { Task } from "./tasks.ts";

export interface ArmRun {
  arm: Arm;
  taskId: number;
  attemptable: boolean;
  ok: boolean;
  why: string;
  answer: string;
  /** Model calls made — one `stream` per turn. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Time inside model calls only, including the tool work they triggered. */
  wallMsModel: number;
  /** From before the first model call to after the loop returns. */
  wallMsInclusive: number;
  error?: string;
}

/**
 * Wraps a gateway so every turn is counted in one place.
 *
 * Counting lives here rather than in each arm so an arm cannot opt out of it, and so
 * the two wall-clock readings come from the same monotonic clock in the same process.
 */
export function countingGateway(gateway: ModelGateway, into: { turns: number; input: number; output: number; modelMs: number }): ModelGateway {
  return {
    async *stream(request: StreamRequest) {
      into.turns += 1;
      const startedAt = performance.now();
      try {
        for await (const event of gateway.stream(request)) {
          if (event.type === "usage") {
            into.input += event.inputTokens ?? 0;
            into.output += event.outputTokens ?? 0;
          }
          yield event;
        }
      } finally {
        into.modelMs += performance.now() - startedAt;
      }
    },
  };
}

/**
 * Runs one task in one arm.
 *
 * A task an arm cannot attempt is returned as `attemptable: false` with no tokens
 * spent, not as a zero score. A zero would read as "tried and failed", which is a
 * different and wrong claim about arm A.
 */
export async function runTask(input: {
  task: Task;
  build: ArmBuild;
  db: Database;
  runId: string;
  gateway: ModelGateway;
  abortPollMs?: number;
}): Promise<ArmRun> {
  const { task, build, db, runId, gateway } = input;
  const startedAt = performance.now();
  const counters = { turns: 0, input: 0, output: 0, modelMs: 0 };

  if (!task.attemptable(build.arm)) {
    return {
      arm: build.arm,
      taskId: task.id,
      attemptable: false,
      ok: false,
      why: `arm ${build.arm} has no tool surface, so it cannot attempt this task`,
      answer: "",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallMsModel: 0,
      wallMsInclusive: Math.round(performance.now() - startedAt),
    };
  }

  let answer = "";
  let error: string | undefined;
  try {
    const outcome = await executeRun({
      db,
      gateway: countingGateway(gateway, counters),
      runId,
      tools: build.tools,
      abortPollMs: input.abortPollMs ?? 20,
    });
    answer = outcome.text;
    if (outcome.status !== "done") error = outcome.error ?? outcome.status;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }

  const verdict = task.validate(answer, build);
  return {
    arm: build.arm,
    taskId: task.id,
    attemptable: true,
    ok: verdict.ok && !error,
    why: error ? `run failed: ${error}` : verdict.why,
    answer,
    turns: counters.turns,
    inputTokens: counters.input,
    outputTokens: counters.output,
    wallMsModel: Math.round(counters.modelMs),
    wallMsInclusive: Math.round(performance.now() - startedAt),
    ...(error ? { error } : {}),
  };
}

/** A gateway that plays a fixed script, for the determinism test. */
export function scriptedGateway(script: (turn: number, request: StreamRequest) => ModelEvent[]) {
  const requests: Array<{ tools: string[] }> = [];
  let turn = 0;
  const gateway: ModelGateway = {
    async *stream(request) {
      requests.push({ tools: (request.tools ?? []).map((t) => t.name) });
      const events = script(turn, request);
      turn += 1;
      for (const event of events) yield event;
    },
  };
  return { gateway, requests };
}

/** One model turn that calls a tool. */
export function callTool(name: string, args: Record<string, unknown> = {}): ModelEvent[] {
  return [
    { type: "tool_call_start", id: `call_${name}`, name },
    { type: "tool_call_end", id: `call_${name}`, arguments: JSON.stringify(args) },
    { type: "usage", inputTokens: 100, outputTokens: 20 },
  ];
}

/** One model turn that answers with text. */
export function say(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", inputTokens: 100, outputTokens: 20 },
  ];
}

/** Median of a list; the table's aggregate rule. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

interface Cell {
  arm: Arm;
  taskId: number;
  ok: boolean;
  turns: number;
  input: number;
  output: number;
  model: number;
  inclusive: number;
  why: string;
}

/** Reduces each (arm, task) group to one median row, carrying the last `why`. */
function cellRowsFor(runs: ArmRun[]): Cell[] {
  const groups = new Map<string, ArmRun[]>();
  for (const run of runs) {
    if (!run.attemptable) continue;
    const key = `${run.arm}:${run.taskId}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [arm, taskId] = key.split(":");
      return {
        arm: arm as Arm,
        taskId: Number(taskId),
        ok: group.filter((r) => r.ok).length > group.length / 2,
        turns: median(group.map((r) => r.turns)),
        input: median(group.map((r) => r.inputTokens)),
        output: median(group.map((r) => r.outputTokens)),
        model: median(group.map((r) => r.wallMsModel)),
        inclusive: median(group.map((r) => r.wallMsInclusive)),
        why: group[0]!.why,
      };
    })
    .sort((a, b) => a.taskId - b.taskId || a.arm.localeCompare(b.arm));
}

/**
 * Renders the result table.
 *
 * Units stated in the header, because a reader will otherwise assume a "turn" is a
 * tool call. Two wall-clock columns, always both. Aggregates are the **median** of
 * the reps per cell — not the fastest, which would flatter whichever arm varies most,
 * and code mode is the arm most likely to vary.
 */
export function renderTable(runs: ArmRun[], reps = 1): string {
  const header =
    "| Arm | Task | OK | Turns (model round trips) | In tokens | Out tokens | Wall (model ms) | Wall (inclusive ms) | Why |";
  const rule = "|---|---|---|---|---|---|---|---|---|";
  // Rows are the cells, each already reduced to its median, so nothing in the table
  // is a single lucky or unlucky rep. `runs` is kept for the JSON, where the spread
  // belongs.
  const rows = runs
    .filter((r) => r.arm === "a" && !r.attemptable)
    .map(
      (r) =>
        `| ${r.arm.toUpperCase()} | ${r.taskId} | n/a | 0 | 0 | 0 | 0 | 0 | ${r.why} |`,
    );
  const cellRows = cellRowsFor(runs).map(
    (c) =>
      `| ${c.arm.toUpperCase()} | ${c.taskId} | ${c.ok ? "pass" : "fail"} | ${c.turns} | ${c.input} | ${c.output} | ${c.model} | ${c.inclusive} | ${c.why} |`,
  );
  // One median per (arm, task) cell, then summed across tasks, so a noisy single rep
  // cannot move an arm's total.
  const medians = cellRowsFor(runs);

  const summary = (["a", "b", "c"] as const).map((arm) => {
    const forArm = medians.filter((m) => m.arm === arm);
    if (forArm.length === 0) return `| ${arm.toUpperCase()} | all | 0/0 | 0 | 0 | 0 | 0 | 0 | not attempted |`;
    return `| ${arm.toUpperCase()} | all (median of ${reps} rep${reps === 1 ? "" : "s"} per cell) | ${forArm.filter((m) => m.ok).length}/${forArm.length} | ${forArm.reduce((n, m) => n + m.turns, 0)} | ${forArm.reduce((n, m) => n + m.input, 0)} | ${forArm.reduce((n, m) => n + m.output, 0)} | ${forArm.reduce((n, m) => n + m.model, 0)} | ${forArm.reduce((n, m) => n + m.inclusive, 0)} | |`;
  });
  return [header, rule, ...rows, ...cellRows, rule, ...summary].join("\n");
}
