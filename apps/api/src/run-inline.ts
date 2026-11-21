import { executeRun } from "@pupbot/agent";
import { database } from "@pupbot/db";
import { createGateway } from "@pupbot/providers";
import type { EnqueueRun } from "./routes/conversations.ts";

let gateway: ReturnType<typeof createGateway> | undefined;

/**
 * `RUN_MODE=inline`: the API request runs the work itself instead of handing it
 * to the pg-boss worker. The run still writes the same `run_event` rows, so a
 * client on `/runs/:id/events` sees the identical stream either way, and
 * `waitUntil` keeps the function alive after the POST has been answered.
 */
export function createInlineEnqueue(): EnqueueRun {
  return async ({ runId, waitUntil }) => {
    gateway ??= createGateway();
    const task = executeRun({ db: database(), gateway, runId })
      .then((outcome) => {
        console.log(`[run ${runId}] ${outcome.status} (${outcome.text.length} chars)`);
      })
      .catch((error: unknown) => {
        console.error(`[run ${runId}] failed`, error);
      });
    if (waitUntil) waitUntil(task);
  };
}
