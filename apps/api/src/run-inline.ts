import { executeRun } from "@terabot/agent";
import type { RunComputer } from "@terabot/agent";
import { DrizzleComputerStore, createComputerRuntime } from "@terabot/computers";
import { database, run as runTable } from "@terabot/db";
import { createGateway } from "@terabot/providers";
import { eq } from "drizzle-orm";
import { fillSinkForBot } from "./fill-sink.ts";
import type { EnqueueRequest, EnqueueRun } from "./routes/conversations.ts";
import { sharedSecretBridge } from "./secret-bridge.ts";
import { releaseRunSecrets, toolsForRun } from "./vault-tools.ts";

export type { EnqueueRequest, EnqueueRun };

let gateway: ReturnType<typeof createGateway> | undefined;
let runComputer: RunComputer | undefined;

/**
 * The computer seam, built once per process and shared with the worker.
 *
 * `RUN_MODE=inline` deployments have no worker at all, so a run in request has to
 * reach the allocator itself. It is the same `runComputerWithLease` the worker
 * uses, which is what keeps the hosted path and the queue path from behaving
 * differently: there is exactly one implementation of "give this bot a machine
 * when a tool asks", and `runComputerWithLease` is where its type is checked
 * against the harness's.
 */
function computerForRuns(): RunComputer {
  if (runComputer) return runComputer;
  const { runComputer: withLease } = createComputerRuntime({ store: new DrizzleComputerStore() });
  runComputer = { withLease };
  return runComputer;
}

/**
 * `RUN_MODE=inline`: the API request runs the work itself instead of handing it
 * to the pg-boss worker. The run still writes the same `run_event` rows, so a
 * client on `/runs/:id/events` sees the identical stream either way, and
 * `waitUntil` keeps the function alive after the POST has been answered.
 */
export function createInlineEnqueue(): EnqueueRun {
  return async ({ runId, userId, waitUntil, computer }) => {
    gateway ??= createGateway();
    // `apps/web` passes its own seam so a run and the request path share one
    // allocator; without one, this process's runtime stands in.
    const db = database();

    // Which bot this run belongs to, so the vault can find its computer. Nothing extra
    // is looked up: the run row already carries the link.
    const [runRow] = await db
      .select({ botId: runTable.botId })
      .from(runTable)
      .where(eq(runTable.id, runId))
      .limit(1);

    // Passed when the bot has a box, absent when it does not — the difference between
    // "observe the field first" and "there is no driver", which the vault reports.
    const fillSink = runRow ? await fillSinkForBot(runRow.botId) : undefined;

    const task = executeRun({
      db,
      gateway,
      runId,
      computer: computer ?? computerForRuns(),
      // The vault's tools, plus the bridge that lets a card's answer reach this
      // run: inline mode runs the bot in the process that accepts the submit.
      tools: toolsForRun({
        awaitSecretRequest: sharedSecretBridge().awaitSecretRequest,
        ...(fillSink ? { fillSink } : {}),
      }),
      ...(userId ? { userId } : {}),
    })
      .then((outcome) => {
        console.log(`[run ${runId}] ${outcome.status} (${outcome.text.length} chars)`);
      })
      .catch((error: unknown) => {
        console.error(`[run ${runId}] failed`, error);
      })
      .finally(() => {
        // A value provided without saving it must not outlive the run it was typed
        // for. This is the only cleanup path, so it runs however the run ended.
        void releaseRunSecrets({ runId }).catch(() => undefined);
      });
    if (waitUntil) waitUntil(task);
  };
}
