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
  | {
      /**
       * A tool the bot ran. `result` is the text the model reads and is part of its
       * context by design — which is why no tool ever puts a secret in it. The UI
       * shows the name and status, not the payload.
       */
      type: "tool_call";
      payload: { id: string; name: string; status: string; result?: string };
    }
  | {
      /**
       * The bot is asking the person for a credential it cannot obtain itself. The
       * payload is the question and nothing else: a value the person submits travels
       * into the vault, or into the submitting process's memory for one run, and
       * never into an event.
       */
      type: "secret.request";
      payload: {
        requestId: string;
        kind: "login" | "card" | "contact";
        reason: string;
        domain: string | null;
        expiresAt: string;
      };
    }
  | { type: "message.completed"; payload: { messageId: string; text: string; status: "complete" | "error" } }
  | {
      type: "run.completed";
      /**
       * `gated` names the refusal that produced this reply instead of model
       * output, so a client can tell an answer from a gate notice without
       * parsing prose.
       */
      payload: { status: "done" | "canceled" | "error"; error?: string; gated?: string };
    };

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
