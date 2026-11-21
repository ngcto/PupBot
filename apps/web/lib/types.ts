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
  /** Connected apps this bot may use. Nothing reads it in a run yet. */
  appIds: string[];
}

/** A connected app as the UI receives it: a name and a state, never a credential. */
export interface AppConnectionView {
  id: string;
  toolkit: string;
  name: string;
  status: "pending" | "active" | "error";
  createdAt: string;
}

export interface ConnectedApp extends AppConnectionView {
  /** A bot may use it. Nothing reads this during a run yet. */
  botEnabled: boolean;
}

export type AppSupport = "managed" | "user-key" | "needs-setup";
export type AppState = "available" | "pending" | "connected" | "failed";

/**
 * One app row as the browser sees it. Declared here, beside the other view types,
 * so a client component never imports the server module that holds the API key.
 */
/**
 * A toolkit the project already holds an auth config for. `authConfigId` and
 * `authConfigManaged` describe that config; the card reads "Needs setup" only when
 * there is neither one nor a flow this beta can drive.
 */
export interface AppCard {
  slug: string;
  name: string;
  description: string;
  logoUrl: string;
  appUrl: string | null;
  categories: string[];
  toolsCount: number;
  support: AppSupport;
  authConfigId: string | null;
  authConfigManaged: boolean | null;
  state: AppState;
  connectionId: string | null;
  statusDetail: string | null;
  lastError: string | null;
}

export interface AppList {
  items: AppCard[];
  nextCursor: string | null;
  categories: string[];
  configured: boolean;
  error: string | null;
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
  /** Shown in Settings > Providers so a custom gateway is identifiable. */
  baseUrl: string;
  /** The provider's default model; a bot picks its own when it is created. */
  modelId: string;
  contextWindow: number | null;
  catalogMatch: string;
  /** How many models the provider itself listed, or null before it was asked. */
  modelCount: number | null;
  /** Whether a key is stored; the key itself never leaves the server. */
  hasKey: boolean;
  /** models.dev provider guessed from the base URL, used to filter the picker. */
  providerHint: string | null;
}

export interface UsageView {
  botId: string;
  inputTokens: number;
  outputTokens: number;
  /** USD across the priced calls; null when the catalogue price is unknown for all of them. */
  costUsd: number | null;
  calls: number;
  unpricedCalls: number;
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
  connections: ConnectedApp[];
  usage: UsageView[];
}
