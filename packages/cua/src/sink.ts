import type { FillEffect, VaultFillOutcome, VaultFillSink } from "@terabot/vault";
import type { CuaDriver } from "./driver/cli.ts";
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
