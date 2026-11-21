import { canStartANewBot, canUseComputer, canSendMessages, describeGate } from "@terabot/billing";

/**
 * Server-side enforcement, in one place.
 *
 * Everything here is a refusal at the action, never a hidden button: a caller
 * that never asked the UI still cannot create a bot, send a message, or reach a
 * computer without access. With billing unconfigured every function returns
 * "allowed" without touching the database.
 */

export { describeGate };

/** Called before a message is accepted into a conversation. */
export async function assertCanSendMessage(userId: string): Promise<void> {
  const access = await canSendMessages(userId);
  if (!access.allowed && access.notice) {
    throw new GateRefusal("message_blocked", access.notice);
  }
}

/** Called before a bot row is written. */
export async function assertCanCreateBot(userId: string): Promise<void> {
  const access = await canStartANewBot(userId);
  if (!access.allowed && access.notice) {
    throw new GateRefusal("bot_blocked", access.notice);
  }
}

/** Called before anything is provisioned, woken, or exec'd on a provider. */
export async function assertCanUseComputer(userId: string): Promise<void> {
  const access = await canUseComputer(userId);
  if (!access.allowed && access.notice) {
    throw new GateRefusal("computer_blocked", access.notice);
  }
}

export interface GateNoticeShape {
  code: string;
  situation: string;
  resolution: string;
}

/**
 * A refusal travels back to the browser as a value, never as a thrown Error:
 * Next.js replaces a server action's thrown message with a generic one in a
 * production build, which would deliver exactly the unhelpful outcome this
 * feature exists to avoid.
 */
export type RefusalResult = { ok: false; notice: GateNoticeShape };

/** Turns a caught gate error into that value; anything else stays a real failure. */
export function refusalOf(error: unknown): RefusalResult | null {
  return error instanceof GateRefusal ? { ok: false, notice: error.notice } : null;
}

export class GateRefusal extends Error {
  readonly code: string;
  readonly notice: GateNoticeShape;
  constructor(code: string, notice: GateNoticeShape) {
    super(`${notice.situation} ${notice.resolution}`);
    this.name = "GateRefusal";
    this.code = code;
    this.notice = notice;
  }
}
