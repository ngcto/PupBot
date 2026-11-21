"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { Button, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, Input, Select, cn } from "@terabot/ui";
import { useEffect, useState } from "react";
import { addModelEndpoint, probeProviderEndpoint, updateModelEndpointProvider } from "../app/actions.ts";
import type { ProviderProbe, TestEndpointResult } from "../app/actions.ts";
import type { EndpointKind } from "@terabot/providers";
import type { EndpointView } from "../lib/types.ts";

type Preset = "openai" | "anthropic" | "custom";

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom OpenAI-compatible" },
];

const PRESET_CONFIG: Record<Preset, { kind: EndpointKind; baseUrl: string; keyHint: string }> = {
  openai: { kind: "openai-chat", baseUrl: "https://api.openai.com/v1", keyHint: "Paste your OpenAI key" },
  anthropic: {
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    keyHint: "Paste your Anthropic key",
  },
  custom: { kind: "openai-chat", baseUrl: "", keyHint: "Paste the key this gateway expects" },
};

const KIND_OPTIONS: Array<{ value: EndpointKind; label: string }> = [
  { value: "openai-chat", label: "OpenAI chat completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

const ADVANCED_KEY = "terabot:provider-advanced";

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

function presetOf(endpoint: EndpointView | null): Preset {
  if (!endpoint) return "openai";
  if (endpoint.kind === "anthropic-messages") return "anthropic";
  const known = endpoint.baseUrl === PRESET_CONFIG.openai.baseUrl;
  return known && endpoint.kind === "openai-chat" ? "openai" : "custom";
}

/**
 * A provider belongs to Settings, not to a bot: kind, key and base URL are set
 * once here, and every bot then picks this provider plus a model. The key is
 * posted to a server action and never read back — an edit leaves it untouched
 * unless a new one is typed.
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
  const [preset, setPreset] = useState<Preset>(() => presetOf(endpoint));
  const [kind, setKind] = useState<EndpointKind>(endpoint?.kind as EndpointKind | undefined ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? PRESET_CONFIG.openai.baseUrl);
  const [label, setLabel] = useState(endpoint?.label ?? "");
  const [apiKey, setApiKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProviderProbe | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(ADVANCED_KEY) === "1") setAdvanced(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ADVANCED_KEY, advanced ? "1" : "0");
  }, [advanced]);

  function changePreset(next: Preset) {
    setPreset(next);
    if (next === "custom") {
      setKind("openai-chat");
      if (preset !== "custom") setBaseUrl("");
      return;
    }
    const config = PRESET_CONFIG[next];
    setKind(config.kind);
    setBaseUrl(config.baseUrl);
  }

  const config = PRESET_CONFIG[preset];

  async function test() {
    setTesting(true);
    setProbe(null);
    setError(null);
    try {
      const result = await probeProviderEndpoint({
        ...(endpoint ? { endpointId: endpoint.id } : {}),
        kind,
        baseUrl,
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
          kind,
          baseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        });
      } else {
        await addModelEndpoint({
          label: label.trim(),
          kind,
          baseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
        <Select
          value={preset}
          onValueChange={(value) => changePreset(value as Preset)}
          options={PRESETS}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm text-ink-muted">Name (optional)</p>
        <Input
          aria-label="Provider name"
          value={label}
          placeholder="OpenAI"
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm text-ink-muted">API key</p>
        <Input
          aria-label="API key"
          type="password"
          placeholder={editing ? "Leave blank to keep the stored key" : config.keyHint}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setProbe(null);
          }}
        />
        <p className="mt-1.5 text-sm text-ink-faint">Stored encrypted on the server. It is never shown again.</p>
      </div>

      {preset === "custom" ? (
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
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-ink-muted">Wire format</span>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as EndpointKind)}
                options={KIND_OPTIONS}
              />
            </div>
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
          </div>
        </CollapsiblePanel>
      </CollapsibleRoot>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={testing || (!endpoint && !baseUrl.trim())}
          onClick={() => void test()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          className={cn(!baseUrl.trim() && "opacity-40")}
          disabled={saving || !baseUrl.trim()}
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
