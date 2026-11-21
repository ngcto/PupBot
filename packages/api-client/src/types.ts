import { z } from "zod";

/**
 * The wire shapes the API returns to a native client, validated where they
 * cross the process boundary. They mirror `@pupbot/db` rows but stay
 * independent: the client never imports server code, so a Metro or Hermes
 * bundle cannot pull in Drizzle or `pg`.
 */

export const sessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
});
export type AuthCookie = z.infer<typeof authCookieSchema>;

export const signInResponseSchema = z.object({
  user: sessionUserSchema,
  cookies: z.array(authCookieSchema),
});
export type SignInResponse = z.infer<typeof signInResponseSchema>;

export const meResponseSchema = z.object({
  user: sessionUserSchema,
  workspaceId: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const avatarSchema = z.object({
  shape: z.string(),
  color: z.string(),
});
export type Avatar = z.infer<typeof avatarSchema>;

export const computerSchema = z.object({
  id: z.string(),
  provider: z.string(),
  status: z.enum(["provisioning", "awake", "asleep", "error", "deleted"]),
  lastUsedAt: z.string().nullable(),
});
export type Computer = z.infer<typeof computerSchema>;

export const modelViewSchema = z.object({
  endpointId: z.string(),
  endpointLabel: z.string(),
  kind: z.string(),
  modelId: z.string(),
  contextWindow: z.number().nullable(),
  catalogMatch: z.string(),
});
export type ModelView = z.infer<typeof modelViewSchema>;

export const botSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: avatarSchema,
  accentColor: z.string(),
  unread: z.boolean(),
  pinned: z.boolean(),
  isPrimary: z.boolean(),
  position: z.number(),
  conversationId: z.string(),
  lastMessagePreview: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  computer: computerSchema.nullable(),
  model: modelViewSchema.nullable(),
  activeRun: z.boolean(),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

export const botDetailSchema = botSummarySchema.extend({
  instructions: z.string(),
  createdAt: z.string(),
});
export type BotDetail = z.infer<typeof botDetailSchema>;

export const botsResponseSchema = z.object({ bots: z.array(botSummarySchema) });
export type BotsResponse = z.infer<typeof botsResponseSchema>;

export const botResponseSchema = z.object({ bot: botDetailSchema });
export type BotResponse = z.infer<typeof botResponseSchema>;

export const messagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    attachmentId: z.string().optional(),
    name: z.string(),
    size: z.number(),
    mime: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    attachmentId: z.string().optional(),
    name: z.string(),
    mime: z.string(),
    url: z.string().optional(),
  }),
  z.object({ type: z.literal("quote"), messageId: z.string(), text: z.string() }),
]);
export type MessagePart = z.infer<typeof messagePartSchema>;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(messagePartSchema),
  status: z.string(),
  createdAt: z.string(),
  runId: z.string().nullable(),
});
export type ChatMessage = z.infer<typeof messageSchema>;

export const conversationMessagesSchema = z.object({
  messages: z.array(messageSchema),
  activeRun: z.object({ id: z.string(), status: z.string() }).nullable(),
});
export type ConversationMessages = z.infer<typeof conversationMessagesSchema>;

export const sendMessageResponseSchema = z.object({
  messageId: z.string(),
  runId: z.string(),
  interruptedRunId: z.string().nullable(),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

/** Event types the worker appends to a run log (`@pupbot/agent/src/events.ts`). */
export type RunEventType =
  | "run.started"
  | "step"
  | "text_delta"
  | "reasoning_delta"
  | "usage"
  | "message.completed"
  | "run.completed";

export interface RunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

/** Payloads are narrowed per type by the client, not by the schema. */
export function payloadText(event: RunEvent): string {
  const text = event.payload.text;
  return typeof text === "string" ? text : "";
}

export function payloadString(event: RunEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}
