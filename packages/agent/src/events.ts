/**
 * The replay log the UI consumes. Pure types with no server-only imports so
 * the web app can subscribe without pulling the harness into the browser.
 */
export type RunStreamEvent =
  | { type: "run.started"; payload: { runId: string; messageId: string } }
  | { type: "step"; payload: { label: string } }
  | { type: "text_delta"; payload: { text: string } }
  | { type: "reasoning_delta"; payload: { text: string } }
  | { type: "usage"; payload: { inputTokens?: number; outputTokens?: number } }
  | { type: "message.completed"; payload: { messageId: string; text: string; status: "complete" | "error" } }
  | { type: "run.completed"; payload: { status: "done" | "canceled" | "error"; error?: string } };

export interface RunEventRecord {
  runId: string;
  seq: number;
  type: RunStreamEvent["type"];
  payload: Record<string, unknown>;
  createdAt: string;
}

export const TERMINAL_RUN_STATUSES = ["done", "canceled", "error"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}
