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

/** Renders the result table. Two wall-clock columns, always both. */
export function renderTable(runs: ArmRun[]): string {
  const header = "| Arm | Task | OK | Turns | In tokens | Out tokens | Wall (model ms) | Wall (inclusive ms) | Why |";
  const rule = "|---|---|---|---|---|---|---|---|---|";
  const rows = runs.map(
    (r) =>
      `| ${r.arm.toUpperCase()} | ${r.taskId} | ${r.attemptable ? (r.ok ? "pass" : "fail") : "n/a"} | ${r.turns} | ${r.inputTokens} | ${r.outputTokens} | ${r.wallMsModel} | ${r.wallMsInclusive} | ${r.why} |`,
  );
  const totals = (["a", "b", "c"] as const).map((arm) => {
    const forArm = runs.filter((r) => r.arm === arm && r.attemptable);
    return {
      arm: arm.toUpperCase(),
      attempted: forArm.length,
      passed: forArm.filter((r) => r.ok).length,
      input: forArm.reduce((n, r) => n + r.inputTokens, 0),
      output: forArm.reduce((n, r) => n + r.outputTokens, 0),
      turns: forArm.reduce((n, r) => n + r.turns, 0),
      model: forArm.reduce((n, r) => n + r.wallMsModel, 0),
      inclusive: forArm.reduce((n, r) => n + r.wallMsInclusive, 0),
    };
  });
  const summary = totals.map(
    (t) => `| ${t.arm} | all | ${t.passed}/${t.attempted} | ${t.turns} | ${t.input} | ${t.output} | ${t.model} | ${t.inclusive} | |`,
  );
  return [header, rule, ...rows, rule, ...summary].join("\n");
}
