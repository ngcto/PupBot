/**
 * The benchmark CLI.
 *
 *   pnpm --filter @terabot/agent bench --arm=a --tasks=all --reps=1
 *
 * Builds a workspace, a bot, a conversation and one run row per task per arm, then
 * drives the **real** `executeRun` through a real model gateway. The arms differ only
 * in the `tools` array, which is what makes the table mean something.
 *
 * Wall clock is only honest on a large machine; this file does not police that, but
 * the output header stamps the machine so a reader can see where a number came from.
 */

import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { Gateway } from "@terabot/providers";
import type { ModelEndpointConfig } from "@terabot/providers";
import {
  auth,
  bot,
  closeDatabase,
  conversation,
  database,
  ensureWorkspace,
  message,
  modelEndpoint,
  newId,
  run,
  user,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import { buildArm } from "../src/bench/arms.ts";
import type { Arm } from "../src/bench/arms.ts";
import { TASKS } from "../src/bench/tasks.ts";
import { renderTable, runTask } from "../src/bench/runner.ts";
import type { ArmRun } from "../src/bench/runner.ts";
import type { ModelGateway } from "@terabot/providers";

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const MODEL = arg("model", process.env.BENCH_MODEL ?? "claude-sonnet-5-5");
const BASE_URL = arg("base-url", process.env.BENCH_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? "");
const API_KEY = process.env.BENCH_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
const REPS = Number(arg("reps", "1"));
const ARM_ARG = arg("arm", "abc");
const TASK_ARG = arg("tasks", "all");

const SYSTEM = [
  "You are a computer-use assistant. Answer the user's question.",
  "When you use a tool, act on what the tool actually returns: an action reports",
  "`effect` as confirmed, unverifiable or refused, and a refusal is never success.",
  "Be brief. When you have the answer, say it plainly.",
].join(" ");

async function main(): Promise<void> {
  if (!BASE_URL || !API_KEY) throw new Error("set ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY (or BENCH_*)");

  const db: Database = database();
  const email = `bench-${Date.now()}@terabot.test`;
  const signUp = await auth().api.signUpEmail({
    body: { email, password: "bench-password-123", name: "Bench" },
    returnHeaders: true,
  });
  const created = signUp.response.user;
  const space = await ensureWorkspace(created.id, "Bench");
  const workspaceId = space.id;

  const endpointId = newId();
  await db.insert(modelEndpoint).values({
    id: endpointId,
    workspaceId,
    kind: "anthropic-messages",
    label: "bench",
    baseUrl: BASE_URL,
    modelId: MODEL,
    catalogMatch: "unmatched",
  });

  const botId = newId();
  const conversationId = newId();
  await db.insert(bot).values({
    id: botId,
    workspaceId,
    name: "Bench Bot",
    avatar: { shape: "mug", color: "amber" },
    accentColor: "#f69412",
    instructions: SYSTEM,
    modelEndpointId: endpointId,
    modelId: MODEL,
  });
  await db.insert(conversation).values({ id: conversationId, botId, title: "Bench" });

  const endpoint: ModelEndpointConfig = {
    kind: "anthropic-messages",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
  };
  const gateway: ModelGateway = new Gateway();

  const arms = ARM_ARG.split("").filter((c): c is Arm => c === "a" || c === "b" || c === "c" || c === "d" || c === "e");
  const tasks = TASK_ARG === "all" ? TASKS : TASKS.filter((t) => TASK_ARG.split(",").includes(String(t.id)));

  const runs: ArmRun[] = [];
  for (const arm of arms) {
    for (const task of tasks) {
      for (let rep = 0; rep < REPS; rep += 1) {
        // Fresh build per run: state must not leak from one task into the next.
        const build = buildArm(arm);

        await db.insert(message).values({
          id: newId(),
          conversationId,
          role: "user",
          parts: [{ type: "text", text: task.prompt }],
          status: "complete",
        });
        const runId = newId();
        await db.insert(run).values({ id: runId, conversationId, botId, status: "queued" });

        const result = await runTask({
          task,
          build,
          db,
          runId,
          gateway: {
            async *stream(request) {
              yield* gateway.stream({ ...request, endpoint });
            },
          },
        });
        runs.push(result);
        process.stderr.write(
          `[${arm}] task ${task.id} rep ${rep + 1}: ${result.attemptable ? (result.ok ? "pass" : "fail") : "n/a"} ` +
            `turns=${result.turns} in=${result.inputTokens} out=${result.outputTokens} ` +
            `model=${result.wallMsModel}ms incl=${result.wallMsInclusive}ms — ${result.why}\n`,
        );
      }
    }
  }

  const table = renderTable(runs, REPS);
  const payload = {
    machine: hostname(),
    model: MODEL,
    baseUrl: BASE_URL,
    reps: REPS,
    arms,
    generatedAt: new Date().toISOString(),
    runs,
  };

  // Resolved from the repo root, not the package: pnpm runs this with the package as
  // cwd, and a result that lands in packages/agent/reports/ is a result nobody finds.
  const dir = fileURLToPath(new URL("../../../reports/tera-81-bench", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${arms.join("")}-${MODEL}-${REPS}rep.json`;
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(table);
  process.stderr.write(`\nwrote ${file}\n`);

  await db.delete(user).where((await import("drizzle-orm")).eq(user.email, email));
  await closeDatabase();
}

main().catch((error: unknown) => {
  process.stderr.write(`bench failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
