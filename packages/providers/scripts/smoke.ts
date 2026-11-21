/**
 * Live smoke test: one sentence per configured endpoint kind.
 *
 *   pnpm --filter @terabot/providers smoke
 *
 * Reads keys from the environment only. A kind with no key (or no model id) is
 * skipped, never faked. Nothing is committed and no key is ever printed.
 */
import { loadEnv } from "@terabot/config/load-env";
import { createGateway } from "../src/index.ts";
import type { EndpointKind, ModelEndpointConfig, ModelEvent, StreamRequest } from "../src/types.ts";

loadEnv();

const PROMPT = "In one sentence, explain what a bot with its own computer can do.";

interface Case {
  kind: EndpointKind;
  endpoint: ModelEndpointConfig;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function cases(): { configured: Case[]; skipped: string[] } {
  const configured: Case[] = [];
  const skipped: string[] = [];

  const openaiKey = env("OPENAI_API_KEY");
  const openaiBase = env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

  if (openaiKey) {
    const chatModel = env("OPENAI_MODEL");
    if (chatModel) {
      configured.push({
        kind: "openai-chat",
        endpoint: { kind: "openai-chat", baseUrl: openaiBase, apiKey: openaiKey, model: chatModel },
      });
    } else {
      skipped.push("openai-chat (set OPENAI_MODEL)");
    }

    const responsesModel = env("OPENAI_RESPONSES_MODEL");
    if (responsesModel) {
      configured.push({
        kind: "openai-responses",
        endpoint: {
          kind: "openai-responses",
          baseUrl: env("OPENAI_RESPONSES_BASE_URL") ?? openaiBase,
          apiKey: openaiKey,
          model: responsesModel,
        },
      });
    } else {
      skipped.push("openai-responses (set OPENAI_RESPONSES_MODEL)");
    }
  } else {
    skipped.push("openai-chat and openai-responses (set OPENAI_API_KEY)");
  }

  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const model = env("ANTHROPIC_MODEL");
    if (model) {
      configured.push({
        kind: "anthropic-messages",
        endpoint: {
          kind: "anthropic-messages",
          baseUrl: env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com/v1",
          apiKey: anthropicKey,
          model,
        },
      });
    } else {
      skipped.push("anthropic-messages (set ANTHROPIC_MODEL)");
    }
  } else {
    skipped.push("anthropic-messages (set ANTHROPIC_API_KEY)");
  }

  return { configured, skipped };
}

interface Outcome {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  error: string | null;
}

async function runCase(modelCase: Case, gateway = createGateway()): Promise<Outcome> {
  const request: StreamRequest = {
    endpoint: modelCase.endpoint,
    messages: [{ role: "user", content: PROMPT }],
    maxTokens: 120,
    signal: AbortSignal.timeout(60_000),
  };

  let text = "";
  // Accumulate: Anthropic reports input and output in separate events, so a
  // later event must never overwrite a count an earlier one already gave us.
  const totals: { inputTokens?: number; outputTokens?: number } = {};
  let error: string | null = null;

  try {
    for await (const event of gateway.stream(request) as AsyncIterable<ModelEvent>) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "usage") {
        if (event.inputTokens !== undefined) totals.inputTokens = event.inputTokens;
        if (event.outputTokens !== undefined) totals.outputTokens = event.outputTokens;
      } else if (event.type === "error") {
        error = `${event.code ?? "error"}: ${event.message}`;
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  // An aborted signal ends the adapter quietly; without this check a timeout
  // would be reported as a success with no text.
  if (!error && request.signal?.aborted) error = "timed out before the stream finished";

  const usage =
    totals.inputTokens === undefined && totals.outputTokens === undefined ? null : totals;
  return { text: text.trim(), usage, error };
}

const { configured, skipped } = cases();

if (configured.length === 0) {
  console.log("No provider keys configured; nothing to smoke. Skipped:");
  for (const entry of skipped) console.log(`  - ${entry}`);
  process.exitCode = 0;
} else {

  let failures = 0;
  for (const modelCase of configured) {
    const started = performance.now();
    const outcome = await runCase(modelCase);
    const latency = Math.round(performance.now() - started);
    const label = `${modelCase.kind} (${modelCase.endpoint.model})`;

    if (outcome.error) {
      failures += 1;
      console.log(`✗ ${label} — ${latency}ms — ${outcome.error}`);
      continue;
    }

    const tokens = outcome.usage
      ? `usage ${outcome.usage.inputTokens ?? "?"} in / ${outcome.usage.outputTokens ?? "?"} out`
      : "usage not reported";
    console.log(`✓ ${label} — ${latency}ms — ${tokens}`);
    console.log(`  "${outcome.text.slice(0, 200)}"`);
  }

  for (const entry of skipped) console.log(`- skipped ${entry}`);
  // Let the event loop drain so piped output is not truncated.
  process.exitCode = failures > 0 ? 1 : 0;
}
