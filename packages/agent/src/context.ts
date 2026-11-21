import type { MessagePart } from "@terabot/db";
import type { ChatMessage } from "@terabot/providers";

export interface ContextBot {
  name: string;
  instructions: string;
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

function partText(parts: MessagePart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/** Bot instructions first, then the tail of the transcript. */
export function buildChatContext(bot: ContextBot, messages: ContextMessage[]): ChatMessage[] {
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

  return [{ role: "system", content: bot.instructions.trim() || defaultInstructions(bot) }, ...transcript];
}
