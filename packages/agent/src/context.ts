import type { MessagePart } from "@terabot/db";
import type { ChatMessage } from "@terabot/providers";

export interface ContextBot {
  name: string;
  instructions: string;
}

/**
 * A refusal the harness could not resolve on its own, phrased once as
 * instructions so the bot relays it instead of the UI rendering it.
 *
 * The billing gate is the first producer: see `describeGate` in
 * `@terabot/billing`. Anything else that must reach the person through the bot
 * (a computer that cannot start for a reason the person must act on) passes a
 * `GateNotice`-shaped object here rather than inventing its own wording.
 */
export interface RunNotice {
  code: string;
  /** What is true, in one sentence. */
  situation: string;
  /** What the person can do about it. */
  resolution: string;
}

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  status: string;
}

const MAX_CONTEXT_MESSAGES = 40;

export function defaultInstructions(bot: ContextBot): string {
  return [
    `You are ${bot.name}, a bot with your own cloud computer.`,
    "Answer as a teammate: short, concrete, and in the user's language.",
    "You can run commands, read and write files, and look at your screen when a tool is available.",
  ].join(" ");
}

/**
 * An attached file is named in the transcript even though the model cannot read
 * its bytes: a message that is only a file still has to reach the model, and a
 * model that cannot see the file must be able to say so.
 */
function partText(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "file" || part.type === "image") return `[attached ${part.type}: ${part.name} (${part.mime})]`;
      return "";
    })
    .join("\n")
    .trim();
}

/**
 * The instruction that makes a refusal land as a normal reply. Exported so a
 * test can assert the wording exists once, and so sibling work (the computer
 * lifecycle) adds to this list instead of writing a second phrasing.
 */
export function noticeInstruction(notice: RunNotice): string {
  return [
    `A gated action was refused: ${notice.situation}`,
    "Tell the person this plainly and in your own words as part of your reply, and do not claim you did it.",
    `What fixes it: ${notice.resolution}`,
  ].join(" ");
}

/** Bot instructions first, then the tail of the transcript. */
export function buildChatContext(
  bot: ContextBot,
  messages: ContextMessage[],
  notices: RunNotice[] = [],
): ChatMessage[] {
  const usable = messages
    .filter((message) => message.status !== "error" && message.role !== "system")
    .slice(-MAX_CONTEXT_MESSAGES);

  const transcript: ChatMessage[] = [];
  for (const message of usable) {
    const content = partText(message.parts);
    if (!content) continue;
    const role = message.role === "user" ? "user" : "assistant";
    const previous = transcript.at(-1);
    if (previous && previous.role === role) previous.content = `${previous.content}\n\n${content}`;
    else transcript.push({ role, content });
  }

  const instructions = bot.instructions.trim() || defaultInstructions(bot);
  // Notices go last in the system message so they outrank the bot's own
  // instructions: a refusal is about this turn, not about who the bot is.
  const content = notices.length > 0 ? [instructions, ...notices.map(noticeInstruction)].join("\n\n") : instructions;
  return [{ role: "system", content }, ...transcript];
}
