import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory, toRef } from "@terabot/computers";
import { CuaDriver, execTargetFor } from "@terabot/cua";
import type { VaultFillSink } from "@terabot/vault";

/**
 * Where a run's fills land, when the bot has a box.
 *
 * **Why this exists.** Without it a fill reports "this bot has no computer driver
 * attached" even for a bot that has one, which names the wrong cause: the driver was
 * never absent, it was never asked. A sink that is present and refuses correctly is
 * worth more than an absent one that refuses ambiguously, and telling those two apart
 * is the whole job of this file.
 *
 * **What it cannot do yet, and says so.** `vault_fill` needs a `{ token, snapshotId }`
 * from an observation of the field, and until the CUA catalogue registers there is no
 * way for a model to make one. So a fill fails with "observe the field first, then fill
 * it" — true and actionable — rather than claiming there is no driver.
 *
 * **The surface is not guessed.** A page fill names the tab the person is on and a
 * desktop fill names the app window; only a caller that watched the run knows which.
 * No run path has that yet, so a fill refuses by name rather than aiming a password at
 * whatever happens to be in front.
 */

let allocator: ComputerAllocator | undefined;

function allocatorFor(): ComputerAllocator {
  allocator ??= new ComputerAllocator({
    store: new DrizzleComputerStore(),
    providers: createProviderFactory({ agent37Template: serverEnv().AGENT37_TEMPLATE }),
  });
  return allocator;
}

/**
 * A driver over a bot's own box, or null when the bot has no ready computer.
 *
 * `bindingForBot` is the allocator's own answer to "which box is this bot on", so this
 * never provisions one: a run that wakes a box does it through `RunComputer`, and a
 * second path that allocated would race the first.
 */
export async function driverForBot(botId: string): Promise<CuaDriver | null> {
  const { state, computer } = await allocatorFor().bindingForBot(botId);
  if (state !== "ready" || !computer) return null;

  const factory = createProviderFactory({ agent37Template: serverEnv().AGENT37_TEMPLATE });
  // The factory reads the provider name and the account id; nothing else about the
  // account record matters for reaching one existing box.
  const provider = factory({ id: computer.accountId ?? "", provider: computer.provider } as Parameters<
    typeof factory
  >[0]);
  return new CuaDriver(execTargetFor(provider, toRef(computer)));
}

/**
 * The sink a run's vault tools use, or `undefined` when the bot has no box.
 *
 * The two failures stay distinguishable here, which is the point:
 *
 * - **No box** → no sink, so `vault_fill` answers "this bot has no computer driver
 *   attached". True, and there is genuinely nothing to type into.
 * - **Box, but nothing aimable** → a sink whose `fill` refuses by name, so `vault_fill`
 *   answers "observe the field first, then fill it". Also true, and the actionable one.
 *
 * Before this, both cases produced the first message, which is why a bot with a working
 * computer still told the model it had no driver.
 */
export async function fillSinkForBot(botId: string): Promise<VaultFillSink | undefined> {
  const driver = await driverForBot(botId);
  if (!driver) return undefined;
  return sinkWithoutSurface();
}

/**
 * The sink for a bot that has a box but no chosen surface yet.
 *
 * Exported so its contract can be tested without provisioning a real computer: a unit
 * test cannot honestly fake a bound box, and a test that mocked the allocator would only
 * assert that the mock was called.
 *
 * It refuses with a code and an instruction. That is deliberately *not* the same answer
 * as having no driver — see `fillSinkForBot`.
 */
export function sinkWithoutSurface(): VaultFillSink {
  return {
    async fill() {
      return {
        effect: "refused",
        verified: false,
        refusalCode: "no_fill_surface",
        evidence: "observe the field on the bot's computer first, then fill it with that element token",
      };
    },
  };
}
