import type { RunTool } from "@terabot/agent";
import { database } from "@terabot/db";
import { SecretRequestService, VaultService, oneShotSecrets, vaultTools } from "@terabot/vault";
import type { VaultFillSink } from "@terabot/vault";

/**
 * How a run gets its tools.
 *
 * The vault's tools are wired here, once, so every run path — inline API, queued
 * worker — gets the same set. The driver's tools are the Cua thread's and register
 * into the same list when they land.
 *
 * The fill sink is where a value leaves server memory and enters a page. Until the
 * driver is wired, no sink is passed: a run then answers honestly that it has no
 * computer to type into, rather than reporting a fill that never happened.
 */
export interface RunToolsOptions {
  fillSink?: VaultFillSink;
  /**
   * Waits for a person to answer an ask-the-user card. Omitted when nobody is
   * listening: the card still renders, the run ends so the answer can arrive as a
   * new message, and nothing hangs.
   */
  awaitSecretRequest?: (input: {
    requestId: string;
    timeoutMs: number;
    signal: AbortSignal;
    status: () => Promise<"pending" | "provided" | "declined" | "expired">;
  }) => Promise<"provided" | "declined" | "expired">;
}

export function toolsForRun(options: RunToolsOptions = {}): RunTool[] {
  const db = database();
  const vault = new VaultService(db);
  return vaultTools({
    db,
    vault,
    oneShot: oneShotSecrets(),
    ...(options.fillSink ? { sink: options.fillSink } : {}),
    ...(options.awaitSecretRequest ? { awaitSecretRequest: options.awaitSecretRequest } : {}),
  });
}

/** Called when a run finishes so a one-shot value does not outlive it. */
export async function releaseRunSecrets(input: { runId: string }): Promise<void> {
  await new SecretRequestService(database()).releaseRun(input);
}
