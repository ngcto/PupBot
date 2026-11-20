import type { MessagePart } from "@pupbot/db";

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
  computer: { id: string; provider: string; status: string } | null;
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
