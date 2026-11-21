import type { RunToolsOptions } from "./vault-tools.ts";

/**
 * Bridging a person's answer to the run that is waiting for it.
 *
 * A bot that asks for a credential is mid-turn: the tool is awaiting the answer, so
 * the run holds its computer lease and its step budget until the person acts. In
 * the documented deployment (`RUN_MODE=inline`) the run and the request that submits
 * the card are in the same process, so a promise here is the whole bridge — no
 * polling, no table to read, and nothing durable to leak.
 *
 * Under a queue deployment the worker runs the job and the API serves the submit,
 * so there is no shared memory. The waiter then reports `expired` immediately rather
 * than pretending: the card still renders and is still saved, and the person's answer
 * arrives to the model as the next user message, which is a worse experience but a
 * truthful one. That limitation is stated in the deploy docs.
 */

type Waiter = (outcome: "provided" | "declined" | "expired") => void;

const waiters = new Map<string, Waiter>();

export interface SecretBridge {
  /** The run's side: wait for the card to be answered, or give up at the deadline. */
  awaitSecretRequest: NonNullable<RunToolsOptions["awaitSecretRequest"]>;
  /** The submitting side: tell a waiting run what the person chose. */
  resolve(requestId: string, outcome: "provided" | "declined" | "expired"): boolean;
}

export function secretBridge(): SecretBridge {
  return {
    async awaitSecretRequest({ requestId, timeoutMs, signal, status }) {
      // A run whose process does not hold the submitter cannot be woken by it. Check
      // the row first: an answer may already be there (a fast person, a retried run).
      const current = await status();
      if (current !== "pending") return current;
      if (signal.aborted) return "expired";

      return new Promise<"provided" | "declined" | "expired">((settle) => {
        let done = false;
        const finish = (outcome: "provided" | "declined" | "expired") => {
          if (done) return;
          done = true;
          waiters.delete(requestId);
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          settle(outcome);
        };

        const onAbort = () => finish("expired");
        const timer = setTimeout(() => finish("expired"), timeoutMs);
        waiters.set(requestId, finish);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    resolve(requestId, outcome) {
      const waiter = waiters.get(requestId);
      if (!waiter) return false;
      waiter(outcome);
      return true;
    },
  };
}

/** The process's one bridge. */
let bridge: SecretBridge | undefined;

export function sharedSecretBridge(): SecretBridge {
  bridge ??= secretBridge();
  return bridge;
}
