import type { ComputerProvider, ComputerRef } from "@terabot/computers";
import type { FillEffect, VaultFillOutcome, VaultFillSink } from "@terabot/vault";
import { CuaDriver, execTargetFor } from "./driver/cli.ts";
import { observeWindow } from "./tools/desktop.ts";
import type { WindowTarget } from "./tools/desktop.ts";
import { fillSecret, isStaleTarget } from "./tools/fill.ts";

/**
 * The implementation of the vault's fill seam.
 *
 * `packages/vault` deliberately does not know how to type: it decides *whether* a
 * value may be used (the item is for this host, the person owns it) and hands the
 * typing to whoever has a computer. This is that whoever. The interface is the
 * vault's, not ours, so the two packages can be reviewed and change apart.
 *
 * Two properties are load-bearing and both come from the interface:
 *
 * - **The target is `{ token, snapshotId }`.** Element tokens die when a newer
 *   read replaces the window's snapshot, and typing a password into a *nearby*
 *   field looks exactly like typing it into the right one. So a sink checks the
 *   snapshot is the one the caller saw and refuses by name when it is not. It
 *   never re-aims.
 * - **Nothing here can carry a value out.** The result is an `effect`, a boolean,
 *   and one masked sentence; a value never enters a message, a refusal, or a
 *   thrown error. `fillSecret` already has no field a value could travel in, and
 *   this wrapper keeps it that way.
 *
 * **Two traps anyone re-implementing this will hit**, both found by running it against
 * a real box rather than a fake:
 *
 * - **Fill in the session that took the observation.** The driver keys its ref cache
 *   by session, so a sink that builds its own driver at the default session finds none
 *   of the caller's refs and gets `browser_binding_stale` — a code that reads like "the
 *   page moved" and means "wrong session". `cuaFillSinkFor` takes `session` for this.
 * - **A page ref pairs with `CuaPageState.snapshotId`, not the tab's `targetId`.**
 *   Passing the target id refuses with `stale_element_token`, which is the staleness
 *   guard doing its job on a caller mistake.
 */
export interface CuaFillSinkOptions {
  driver: CuaDriver;
  /**
   * Which surface to fill on.
   *
   * A page fill names the browser tab the person is on; a desktop fill names the
   * app window. The vault passes one URL and one element, and the caller that
   * built the run knows which of the two is in front of the user, so this is
   * configuration rather than something the sink guesses.
   */
  surface:
    | { kind: "page"; targetId: string; tabId: string }
    | { kind: "window"; window: WindowTarget };
  signal?: AbortSignal;
}

/**
 * The driver's vocabulary is the vault's vocabulary; this is the proof of that.
 *
 * The "unknown" arm is not defensive padding: `readEffect` turns a payload with no
 * recognisable `effect` into `confirmed` when it carries `status: "ok"`, which is
 * right for a read and wrong for a write. A fill that could not classify its
 * driver's answer must not tell the vault the field holds the value, so anything
 * that is not explicitly confirmed is reported as not confirmed.
 */
function asFillEffect(effect: string): FillEffect {
  return effect === "confirmed" ||
    effect === "unverifiable" ||
    effect === "suspected_noop" ||
    effect === "partial" ||
    effect === "refused"
    ? effect
    : "unverifiable";
}

/** A sentence a model may repeat: it describes the field, never the value. */
function evidenceFor(input: {
  field: string;
  effect: FillEffect;
  landed: boolean | undefined;
  verified: boolean;
}): string | undefined {
  const name = input.field === "password" ? "password field" : `${input.field} field`;
  if (input.landed === true) return `the ${name} holds the value the vault supplied`;
  if (input.effect === "refused") return `the ${name} was not filled`;
  if (input.verified) return `the ${name} was written and read back`;
  return undefined;
}

export function createCuaFillSink(options: CuaFillSinkOptions): VaultFillSink {
  return {
    async fill({ target, field, value }): Promise<VaultFillOutcome> {
      // `url` is deliberately unused: the vault has already refused a fill whose
      // host does not match the item, so re-checking it here would be a second
      // opinion nobody asked for. The surface this sink was built for is the
      // authority on *where* the value goes.
      //
      // The page route refs a tab; the desktop route refs a window. Both are
      // observed here rather than trusted from the caller, because the staleness
      // check has to use a read this call made.
      if (options.surface.kind === "page") {
        const result = await fillSecret(options.driver, {
          // Unused on this route: a page fill names a tab, not a window.
          target: { pid: 0 },
          fill: {
            kind: "page",
            targetId: options.surface.targetId,
            tabId: options.surface.tabId,
            ref: target.token,
            snapshotId: target.snapshotId,
          },
          value,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const effect = asFillEffect(result.effect);
        const evidence = evidenceFor({ field, effect, landed: result.landed, verified: result.verified });
        return {
          effect,
          verified: result.verified,
          ...(evidence ? { evidence } : {}),
          ...(result.refusal ? { refusalCode: result.refusal.code } : {}),
        };
      }

      // A desktop fill has to observe the window itself: the observation the
      // caller passed is what a stale token is detected against, and this sink's
      // own read is what proves the field is still there.
      const observation = await observeWindow(options.driver, options.surface.window, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (observation.snapshotId !== target.snapshotId) {
        return {
          effect: "refused",
          verified: false,
          refusalCode: "stale_element_token",
          evidence: "the window was re-read since the field was chosen, so nothing was typed",
        };
      }
      const result = await fillSecret(options.driver, {
        target: options.surface.window,
        fill: {
          kind: "element",
          observation,
          elementToken: target.token,
        },
        value,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const effect = asFillEffect(result.effect);
      const evidence = evidenceFor({ field, effect, landed: result.landed, verified: result.verified });
      return {
        effect,
        verified: result.verified,
        ...(evidence ? { evidence } : {}),
        ...(result.refusal ? { refusalCode: result.refusal.code } : {}),
      };
    },
  };
}

/** Re-exported so a caller can tell a stale target from another refusal. */
export { isStaleTarget };

/**
 * A sink for a box, built from the provider and the ref the run is on.
 *
 * This is the registration point `packages/vault`'s interface was waiting for: the
 * vault decides *whether* a value may be used and hands the typing to whoever has the
 * computer, and this connects the two without either package knowing about the other's
 * transport. `apps/api` passes the result to `toolsForRun`.
 *
 * `surface` is the caller's to name because only the caller knows which window or tab
 * is in front of the user — the sink does not guess, and a fill aimed at the wrong
 * window is exactly the failure this path exists to prevent.
 */
export function cuaFillSinkFor(input: {
  provider: Pick<ComputerProvider, "exec">;
  ref: ComputerRef;
  surface: CuaFillSinkOptions["surface"];
  signal?: AbortSignal;
  /**
   * The driver session to fill in.
   *
   * **This must be the session that took the observation the caller's `token` came
   * from.** The driver keys its element and ref caches by session, so a sink that
   * starts its own defaults to a session where the caller's refs do not exist, and
   * every fill comes back `browser_binding_stale` — a refusal that looks like
   * staleness and is really a cache miss. It defaults only because a caller that
   * reads, fills and acts through one `CuaDriver` should not have to say so twice.
   */
  session?: string;
}): VaultFillSink {
  return createCuaFillSink({
    driver: new CuaDriver(execTargetFor(input.provider, input.ref), {
      ...(input.session ? { session: input.session } : {}),
    }),
    surface: input.surface,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
