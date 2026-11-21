import type { MessagePart } from "@terabot/db";

export type ComputerBinding = "unbound" | "binding" | "ready" | "blocked";

export type ComputerRowStatus = "provisioning" | "awake" | "asleep" | "waking" | "error" | "deleted";

/** What the computer card and the composer read: truthful state, never a spinner forever. */
export interface ComputerView {
  id: string | null;
  /** The provider's own box id, shown only behind Advanced. */
  externalId: string | null;
  provider: string | null;
  status: ComputerRowStatus | null;
  binding: ComputerBinding;
  reason: string | null;
}

export interface BotView {
  id: string;
  name: string;
  shape: string;
  color: string;
  accentColor: string;
  instructions: string;
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  sectionId: string | null;
  position: number;
  conversationId: string;
  lastMessagePreview: string | null;
  isPrimary: boolean;
  computer: ComputerView;
  endpointId: string | null;
}

export interface SectionView {
  id: string;
  name: string;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  status: string;
  createdAt: string;
  runId: string | null;
}

export interface EndpointView {
  id: string;
  label: string;
  kind: string;
  modelId: string;
  contextWindow: number | null;
  catalogMatch: string;
}

export interface ShellUser {
  id: string;
  name: string;
  email: string;
}

export interface ShellData {
  user: ShellUser;
  apiUrl: string;
  bots: BotView[];
  sections: SectionView[];
  activeBot: BotView | null;
  messages: MessageView[];
  activeRunId: string | null;
  endpoints: EndpointView[];
}
