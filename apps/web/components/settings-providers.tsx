"use client";

import { Button, toast } from "@terabot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteModelEndpoint, probeProviderEndpoint } from "../app/actions.ts";
import type { ProviderProbe } from "../app/actions.ts";
import type { EndpointView } from "../lib/types.ts";
import { ProviderForm, TestResultLine } from "./provider-form.tsx";

function kindLabel(kind: string): string {
  if (kind === "anthropic-messages") return "Anthropic Messages";
  if (kind === "openai-responses") return "OpenAI Responses";
  return "OpenAI chat";
}

/**
 * Settings > Providers. A provider is configured once here — kind, key, base URL
 * — and every bot then picks this provider plus a model, so no bot dialog has to
 * ask for a key again.
 */
export function ProvidersPanel({ endpoints }: { endpoints: EndpointView[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProviderProbe>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function test(endpoint: EndpointView) {
    setProbingId(endpoint.id);
    setError(null);
    try {
      const result = await probeProviderEndpoint({ endpointId: endpoint.id, kind: endpoint.kind as never });
      setProbes((current) => ({ ...current, [endpoint.id]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the provider could not be reached");
    } finally {
      setProbingId(null);
    }
  }

  async function remove(endpoint: EndpointView) {
    setConfirmingId(null);
    try {
      await deleteModelEndpoint(endpoint.id);
      toast(`Removed ${endpoint.label}`);
      router.refresh();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The provider could not be removed");
    }
  }

  if (adding || editingId) {
    const editing = endpoints.find((entry) => entry.id === editingId) ?? null;
    return (
      <ProviderForm
        endpoint={editing}
        onSaved={() => {
          setAdding(false);
          setEditingId(null);
          router.refresh();
        }}
        onCancel={() => {
          setAdding(false);
          setEditingId(null);
        }}
      />
    );
  }

  return (
    <div data-testid="providers-panel">
      <p className="mt-3 max-w-[560px] text-body text-ink-secondary">
        Connect a model provider once. Bots then pick a provider and a model when they are created, so a
        key is never typed into a bot again.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg bg-raised" data-testid="provider-list">
        {endpoints.length === 0 ? (
          <div className="px-4 py-6" data-testid="providers-empty">
            <p className="text-body text-ink">No provider yet.</p>
            <p className="mt-1 text-body text-ink-secondary">
              Add one to start a bot — OpenAI, Anthropic, or any OpenAI-compatible base URL.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {endpoints.map((endpoint) => {
              const probe = probes[endpoint.id];
              return (
                <div key={endpoint.id} className="px-4 py-3" data-testid={`provider-row-${endpoint.id}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-body font-medium text-ink">
                        {endpoint.label}
                        <span className="rounded-pill bg-raised-3 px-2 py-0.5 text-sm text-ink-muted">
                          {kindLabel(endpoint.kind)}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-sm text-ink-muted" title={endpoint.baseUrl}>
                        {endpoint.baseUrl}
                      </p>
                      <p className="mt-0.5 text-sm text-ink-faint">
                        {endpoint.modelCount === null
                          ? "Model list not read yet"
                          : `${endpoint.modelCount} model${endpoint.modelCount === 1 ? "" : "s"} listed`}
                        {" · "}
                        {endpoint.hasKey ? "key stored" : "no key"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={probingId === endpoint.id}
                        onClick={() => void test(endpoint)}
                      >
                        {probingId === endpoint.id ? "Testing…" : "Test"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditingId(endpoint.id)}>
                        Edit
                      </Button>
                      {confirmingId === endpoint.id ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmingId(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="primary" onClick={() => void remove(endpoint)}>
                            Delete provider
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmingId(endpoint.id)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                  {probe ? (
                    <div className="mt-2 space-y-1 rounded-md border border-hairline px-3 py-2">
                      <p className="text-sm text-ink-muted">{probe.note}</p>
                      {probe.test ? <TestResultLine result={probe.test} /> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          Add provider
        </Button>
      </div>

      {error ? <p className="mt-2 text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
