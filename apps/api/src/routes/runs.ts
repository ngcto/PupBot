import { isTerminal } from "@terabot/agent";
import { bot, conversation, database, findWorkspace, run, runEvent } from "@terabot/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../types.ts";

const POLL_MS = 120;

async function scopeRun(userId: string, runId: string) {
  const workspace = await findWorkspace(userId);
  if (!workspace) return null;
  const rows = await database()
    .select({ run })
    .from(run)
    .innerJoin(bot, eq(run.botId, bot.id))
    .innerJoin(conversation, eq(run.conversationId, conversation.id))
    .where(and(eq(run.id, runId), eq(bot.workspaceId, workspace.id)))
    .limit(1);
  return rows[0]?.run ?? null;
}

export const runRoutes = new Hono<AppEnv>()
  .get("/runs/:id", async (c) => {
    const found = await scopeRun(c.get("user").id, c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json({ run: found });
  })
  /**
   * Replay log as SSE. `?after=<seq>` resumes exactly after the last event a
   * client saw, so a reconnect loses nothing.
   */
  .get("/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    const found = await scopeRun(c.get("user").id, runId);
    if (!found) return c.json({ error: "not_found" }, 404);

    const after = Number.parseInt(c.req.query("after") ?? "0", 10);
    let cursor = Number.isFinite(after) && after > 0 ? after : 0;
    const db = database();

    c.header("cache-control", "no-cache, no-transform");
    c.header("x-accel-buffering", "no");

    return streamSSE(
      c,
      async (stream) => {
        stream.onAbort(() => {
          cursor = -1;
        });

        await stream.writeSSE({
          event: "open",
          data: JSON.stringify({ runId, after: cursor }),
        });

        while (cursor >= 0) {
          const events = await db
            .select()
            .from(runEvent)
            .where(and(eq(runEvent.runId, runId), gt(runEvent.seq, cursor)))
            .orderBy(asc(runEvent.seq))
            .limit(200);

          for (const event of events) {
            cursor = event.seq;
            await stream.writeSSE({
              id: String(event.seq),
              event: event.type,
              data: JSON.stringify({
                seq: event.seq,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt,
              }),
            });
          }

          const current = await db
            .select({ status: run.status })
            .from(run)
            .where(eq(run.id, runId))
            .limit(1);
          const status = current[0]?.status;

          if (!status) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ runId, status: "missing" }),
            });
            break;
          }

          if (isTerminal(status)) {
            // The closing events can land a moment after the status, so read
            // the log once more before calling the stream finished.
            const tail = await db
              .select({ seq: runEvent.seq })
              .from(runEvent)
              .where(and(eq(runEvent.runId, runId), gt(runEvent.seq, cursor)))
              .limit(1);
            if (tail.length === 0) {
              await stream.writeSSE({
                event: "done",
                data: JSON.stringify({ runId, status }),
              });
              break;
            }
          } else if (events.length === 0) {
            await stream.sleep(POLL_MS);
          }
        }
      },
      async (error, stream) => {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: error instanceof Error ? error.message : "stream failed" }),
        });
      },
    );
  });
