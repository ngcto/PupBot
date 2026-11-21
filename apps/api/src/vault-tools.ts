import type { RunTool } from "@terabot/agent";
import { CuaDriver, createCuaFillSink, execTargetFor } from "@terabot/cua";
import type { ComputerProvider, ComputerRef } from "@terabot/computers";
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

/**
 * The vault's fill seam, implemented by the Cua Driver.
 *
 * `packages/vault` decides *whether* a value may be used and hands the typing to
 * whoever has the computer; this is that whoever. Until now no sink was passed, so a
 * fill answered honestly that it had nothing to type into — correct, and useless.
 *
 * `surface` is the caller's to name because only the caller knows which window or tab
 * is in front of the user. It is a parameter rather than a guess here for that reason:
 * a fill aimed at the wrong window is the failure this whole path exists to prevent.
 */
export function cuaFillSinkFor(input: {
  provider: Pick<ComputerProvider, "exec">;
  ref: ComputerRef;
  surface: Parameters<typeof createCuaFillSink>[0]["surface"];
  signal?: AbortSignal;
}): VaultFillSink {
  const driver = new CuaDriver(execTargetFor(input.provider, input.ref));
  return createCuaFillSink({
    driver,
    surface: input.surface,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** Called when a run finishes so a one-shot value does not outlive it. */
export async function releaseRunSecrets(input: { runId: string }): Promise<void> {
  await new SecretRequestService(database()).releaseRun(input);
}
