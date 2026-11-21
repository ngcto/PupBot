"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { Button, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, Input, Select, cn } from "@terabot/ui";
import { BUILTIN_PROVIDERS } from "@terabot/providers";
import { useEffect, useState } from "react";
import { addModelEndpoint, probeProviderEndpoint, updateModelEndpointProvider } from "../app/actions.ts";
import type { ProviderProbe, TestEndpointResult } from "../app/actions.ts";
import type { DetailField, EndpointKind } from "@terabot/providers";
import type { EndpointView } from "../lib/types.ts";

/**
 * A provider is either one of ours — a fixed base URL, a key, done — or a custom
 * OpenAI-compatible endpoint the user points somewhere themselves. The built-in
 * list comes from `BUILTIN_PROVIDERS`, so a URL added there appears here with
 * nothing else to change.
 */
type Choice = string;

const CUSTOM = "custom";
const ANTHROPIC = "anthropic";

const CUSTOM_CONFIG: Record<string, { kind: EndpointKind; baseUrl: string; keyHint: string }> = {
  [ANTHROPIC]: {
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    keyHint: "Paste your Anthropic key",
  },
  [CUSTOM]: { kind: "openai-chat", baseUrl: "", keyHint: "Paste the key this gateway expects" },
};

const CHOICES: Array<{ value: Choice; label: string }> = [
  ...BUILTIN_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.name })),
  { value: ANTHROPIC, label: "Anthropic" },
  { value: CUSTOM, label: "Custom OpenAI-compatible" },
];

const KIND_OPTIONS: Array<{ value: EndpointKind; label: string }> = [
  { value: "openai-chat", label: "OpenAI chat completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

const ADVANCED_KEY = "terabot:provider-advanced";

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** The built-in a saved row is, matched by id and then by its URL for an old row. */
function builtinOf(endpoint: EndpointView | null) {
  if (!endpoint) return undefined;
  return (
    BUILTIN_PROVIDERS.find((provider) => provider.id === endpoint.builtinId) ??
    BUILTIN_PROVIDERS.find((provider) => provider.baseUrl === endpoint.baseUrl)
  );
}

function choiceOf(endpoint: EndpointView | null): Choice {
  if (!endpoint) return BUILTIN_PROVIDERS[0]?.id ?? CUSTOM;
  const builtin = builtinOf(endpoint);
  if (builtin) return builtin.id;
  if (endpoint.kind === "anthropic-messages" && endpoint.baseUrl === CUSTOM_CONFIG[ANTHROPIC]!.baseUrl) {
    return ANTHROPIC;
  }
  return CUSTOM;
}

export function TestResultLine({ result }: { result: TestEndpointResult }) {
  if (result.ok) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-success" role="status">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} className="mt-0.5 shrink-0" />
        <span>
          Replied in {result.latencyMs}&nbsp;ms
          {result.text ? `: “${result.text.slice(0, 80)}”` : ""}
          {result.usage
            ? ` · ${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out`
            : ""}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-sm text-danger" role="alert">
      <HugeiconsIcon icon={Alert02Icon} size={14} className="mt-0.5 shrink-0" />
      <span>
        {result.error?.code ?? "error"}
        {result.error?.status ? ` (${result.error.status})` : ""}: {result.error?.message ?? "the call failed"}
      </span>
    </p>
  );
}

/**
 * A provider belongs to Settings, not to a bot: the provider, its key and — for a
 * custom endpoint only — its base URL are set once here, and every bot then picks
 * this provider plus a model. The key is posted to a server action and never read
 * back — an edit leaves it untouched unless a new one is typed.
 */
export function ProviderForm({
  endpoint = null,
  onSaved,
  onCancel,
}: {
  endpoint?: EndpointView | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(endpoint);
  const [choice, setChoice] = useState<Choice>(() => choiceOf(endpoint));
  const [kind, setKind] = useState<EndpointKind>((endpoint?.kind as EndpointKind | undefined) ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
  const [label, setLabel] = useState(endpoint?.label ?? "");
  const [apiKey, setApiKey] = useState("");
  // Blank means "not mine": the server may fill it. A number here is the user's
  // and is never replaced.
  const hadTypedContext = Boolean(
    endpoint?.contextWindow && !endpoint.detailSources.includes("contextWindow"),
  );
  const [contextWindow, setContextWindow] = useState(
    hadTypedContext ? String(endpoint!.contextWindow) : "",
  );
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProviderProbe | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === choice);
  // A built-in's URL is fixed, so the form never shows it and never accepts one.
  const custom = !builtin;
  const config = custom ? CUSTOM_CONFIG[choice === ANTHROPIC ? ANTHROPIC : CUSTOM]! : null;
  const targetUrl = builtin?.baseUrl ?? baseUrl;
  const canSave = Boolean(targetUrl.trim());
  // What the catalogue filled before, shown as the placeholder so a blank field
  // still says what the endpoint will use.
  const autoContext =
    endpoint?.detailSources.includes("contextWindow") && endpoint.contextWindow
      ? compactTokens(endpoint.contextWindow)
      : null;
  const typedContext = contextWindow.trim() ? Number(contextWindow) : null;
  // Blanking a window the user set earlier is a deliberate clear, so it must send
  // an explicit null; sending nothing would leave the stored number in place and
  // the field could never be emptied.
  const cleared = typedContext === null && hadTypedContext;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(ADVANCED_KEY) === "1") setAdvanced(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ADVANCED_KEY, advanced ? "1" : "0");
  }, [advanced]);

  function changeChoice(next: Choice) {
    setChoice(next);
    setProbe(null);
    const provider = BUILTIN_PROVIDERS.find((entry) => entry.id === next);
    if (provider) {
      setKind(provider.kind);
      setBaseUrl(provider.baseUrl);
      return;
    }
    const preset = CUSTOM_CONFIG[next];
    if (preset) {
      setKind(preset.kind);
      setBaseUrl(preset.baseUrl);
    }
  }

  async function test() {
    setTesting(true);
    setProbe(null);
    setError(null);
    try {
      const result = await probeProviderEndpoint({
        ...(endpoint ? { endpointId: endpoint.id } : {}),
        kind: builtin?.kind ?? kind,
        ...(builtin ? { builtinId: builtin.id } : { baseUrl }),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setProbe(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the provider could not be reached");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (endpoint) {
        await updateModelEndpointProvider({
          endpointId: endpoint.id,
          label: label.trim() || endpoint.label,
          kind: builtin?.kind ?? kind,
          ...(builtin ? { builtinId: builtin.id } : { baseUrl }),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          // A field the user typed is theirs, so its auto badge goes; a blank
          // one leaves whatever the catalogue filled in place — unless they
          // cleared a value they had set, which is an explicit clear.
          ...(typedContext !== null
            ? { contextWindow: typedContext, userSetFields: ["contextWindow"] as DetailField[] }
            : cleared
              ? { contextWindow: null }
              : {}),
        });
      } else {
        await addModelEndpoint({
          label: label.trim(),
          kind: builtin?.kind ?? kind,
          ...(builtin ? { builtinId: builtin.id } : { baseUrl }),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(typedContext !== null ? { contextWindow: typedContext } : {}),
        });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the provider could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="provider-form">
      <div className="flex items-center justify-between gap-4">
        <span className="text-body">Provider</span>
        <Select value={choice} onValueChange={(value) => changeChoice(value)} options={CHOICES} />
      </div>

      <div>
        <p className="mb-1.5 text-sm text-ink-muted">Name (optional)</p>
        <Input
          aria-label="Provider name"
          value={label}
          placeholder={builtin?.name ?? "My gateway"}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm text-ink-muted">API key</p>
        <Input
          aria-label="API key"
          type="password"
          placeholder={editing ? "Leave blank to keep the stored key" : builtin?.keyHint ?? config!.keyHint}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setProbe(null);
          }}
        />
        <p className="mt-1.5 text-sm text-ink-faint">Stored encrypted on the server. It is never shown again.</p>
      </div>

      {custom ? (
        <div>
          <p className="mb-1.5 text-sm text-ink-muted">Base URL</p>
          <Input
            aria-label="Base URL"
            value={baseUrl}
            placeholder="http://localhost:8080/v1"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setProbe(null);
            }}
          />
        </div>
      ) : null}

      <CollapsibleRoot open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger className="flex h-8 items-center gap-1 text-sm text-ink-muted hover:text-ink">
          Advanced {advanced ? "−" : "+"}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-3 pt-2">
            {custom ? (
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-ink-muted">Wire format</span>
                <Select
                  value={kind}
                  onValueChange={(value) => setKind(value as EndpointKind)}
                  options={KIND_OPTIONS}
                />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                {builtin!.name} uses OpenAI chat completions at a fixed address. Nothing to set.
              </p>
            )}
            {custom ? (
              <div>
                <p className="mb-1.5 text-sm text-ink-muted">Base URL</p>
                <Input
                  aria-label="Advanced base URL"
                  value={baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                    setProbe(null);
                  }}
                />
              </div>
            ) : null}
            <div>
              <p className="mb-1.5 text-sm text-ink-muted">Context window</p>
              <Input
                aria-label="Context window"
                inputMode="numeric"
                value={contextWindow}
                placeholder={
                  autoContext ? `${autoContext} (filled)` : "Filled from models.dev when it is known"
                }
                onChange={(event) => {
                  setContextWindow(event.target.value.replace(/[^0-9]/g, ""));
                  setProbe(null);
                }}
              />
              <p className="mt-1.5 text-sm text-ink-faint">
                {contextWindow.trim()
                  ? "Yours. Auto-population will never replace it."
                  : "Only a blank field is filled from models.dev."}
              </p>
            </div>
          </div>
        </CollapsiblePanel>
      </CollapsibleRoot>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={testing || !canSave}
          onClick={() => void test()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          className={cn(!canSave && "opacity-40")}
          disabled={saving || !canSave}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : editing ? "Save provider" : "Add provider"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {probe ? (
        <div className="space-y-1.5 rounded-md border border-hairline px-3 py-2">
          <p className="text-sm text-ink-muted" data-testid="provider-probe-note">
            {probe.note}
          </p>
          {probe.test ? <TestResultLine result={probe.test} /> : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
