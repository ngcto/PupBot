import { executeRun } from "@terabot/agent";
import { database, run as runTable } from "@terabot/db";
import { createGateway } from "@terabot/providers";
import { eq } from "drizzle-orm";
import { fillSinkForBot } from "./fill-sink.ts";
import type { EnqueueRequest, EnqueueRun } from "./routes/conversations.ts";
import { sharedSecretBridge } from "./secret-bridge.ts";
import { releaseRunSecrets, toolsForRun } from "./vault-tools.ts";

export type { EnqueueRequest, EnqueueRun };

let gateway: ReturnType<typeof createGateway> | undefined;

/**
 * `RUN_MODE=inline`: the API request runs the work itself instead of handing it
 * to the pg-boss worker. The run still writes the same `run_event` rows, so a
 * client on `/runs/:id/events` sees the identical stream either way, and
 * `waitUntil` keeps the function alive after the POST has been answered.
 */
export function createInlineEnqueue(): EnqueueRun {
  return async ({ runId, waitUntil, computer }) => {
    gateway ??= createGateway();
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
      computer,
      // The vault's tools, plus the bridge that lets a card's answer reach this
      // run: inline mode runs the bot in the process that accepts the submit.
      tools: toolsForRun({
        awaitSecretRequest: sharedSecretBridge().awaitSecretRequest,
        ...(fillSink ? { fillSink } : {}),
      }),
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
