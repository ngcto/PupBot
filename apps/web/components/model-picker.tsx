"use client";

import { Combobox } from "@terabot/ui";
import type { ComboboxItem } from "@terabot/ui";
import { useEffect, useRef, useState } from "react";
import { endpointModelChoices, lookupCatalogModel, searchCatalogModels } from "../app/actions.ts";
import type { CatalogModelView, EndpointModelChoices } from "../app/actions.ts";

export function compactTokens(tokens: number | null): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function describeCatalogModel(model: CatalogModelView): string {
  const bits: string[] = [model.provider];
  const context = compactTokens(model.contextWindow);
  if (context) bits.push(`${context} context`);
  if (model.pricing?.input !== undefined) bits.push(`$${model.pricing.input}/M in`);
  if (model.pricing?.output !== undefined) bits.push(`$${model.pricing.output}/M out`);
  if (!model.pricing) bits.push("no price");
  if (!model.toolSupport) bits.push("no tool calls");
  return bits.join(" · ");
}

/**
 * models.dev keys by provider, so the same model id appears once per provider
 * that publishes it. The picker selects an id, not a provider row, so collapse
 * the duplicates — preferring the hinted provider when there is one.
 */
function uniqueModels(rows: CatalogModelView[], hint?: string | null): CatalogModelView[] {
  const byId = new Map<string, CatalogModelView>();
  for (const row of rows) {
    const existing = byId.get(row.modelId);
    if (!existing || (hint && row.provider === hint && existing.provider !== hint)) {
      byId.set(row.modelId, row);
    }
  }
  return [...byId.values()];
}

function toItem(model: CatalogModelView, details: boolean): ComboboxItem {
  return {
    value: model.modelId,
    label: model.modelId,
    description: details ? describeCatalogModel(model) : model.provider,
  };
}

/**
 * A model id with catalogue search. An id outside models.dev is allowed — the
 * row warns instead of blocking, because BYO endpoints legitimately serve
 * models the catalogue has never seen.
 */
export function ModelPicker({
  value,
  onChange,
  providerHint,
  placeholder = "Search models, or type an id",
  ariaLabel = "Model",
  details = false,
  disabled = false,
  endpointId,
}: {
  value: string;
  onChange: (value: string) => void;
  providerHint?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  /** Context window and pricing are advanced details; off by default. */
  details?: boolean;
  /** A poll in flight captured the model id, so the field is frozen. */
  disabled?: boolean;
  /** When set, the endpoint's own `GET /models` list is preferred over models.dev. */
  endpointId?: string | null;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [items, setItems] = useState<ComboboxItem[]>([]);
  const [match, setMatch] = useState<CatalogModelView | null>(null);
  const [checked, setChecked] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchToken = useRef(0);
  const lookupToken = useRef(0);
  const provider = useRef(providerHint);
  const [live, setLive] = useState<EndpointModelChoices | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setLive(null);
      return;
    }
    let alive = true;
    void endpointModelChoices(endpointId)
      .then((choices) => {
        if (alive) setLive(choices);
      })
      .catch(() => {
        if (alive) setLive(null);
      });
    return () => {
      alive = false;
    };
  }, [endpointId]);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    if (provider.current === providerHint) return;
    provider.current = providerHint;
    // Results from the previous provider must not stay selectable while the
    // new search is in flight.
    setItems([]);
    setMatch(null);
    setChecked(false);
  }, [providerHint]);

  useEffect(() => {
    const token = ++searchToken.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const rows = await searchCatalogModels({
          query: inputValue.trim() || undefined,
          provider: providerHint ?? undefined,
          limit: 20,
        });
        if (token !== searchToken.current) return;
        setItems(uniqueModels(rows, providerHint).map((row) => toItem(row, details)));
      } catch {
        if (token === searchToken.current) setItems([]);
      } finally {
        if (token === searchToken.current) setSearching(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [inputValue, providerHint, details]);

  useEffect(() => {
    const token = ++lookupToken.current;
    setChecked(false);
    if (!value.trim()) {
      setMatch(null);
      setChecked(true);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const row = await lookupCatalogModel({
          modelId: value.trim(),
          providerHint: providerHint ?? undefined,
        });
        if (token !== lookupToken.current) return;
        setMatch(row);
      } catch {
        if (token === lookupToken.current) setMatch(null);
      } finally {
        if (token === lookupToken.current) setChecked(true);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [value, providerHint]);

  const liveModels = live?.models ?? [];
  const usingLive = liveModels.length > 0;
  const needle = inputValue.trim().toLowerCase();
  const liveItems: ComboboxItem[] = usingLive
    ? liveModels
        .filter((model) => !needle || model.id.toLowerCase().includes(needle))
        .map((model) => ({
          value: model.id,
          label: model.id,
          description: details ? describeChoice(model) : undefined,
        }))
    : [];

  const typed = value.trim();
  const selectedInLive = !usingLive || liveModels.some((model) => model.id === typed);
  // A half-typed id is on its way to a listed one, so only warn once nothing
  // the endpoint lists could still match what is in the field.
  const stillTyping = usingLive && !!typed && liveModels.some((model) => model.id.toLowerCase().startsWith(typed.toLowerCase()));
  const pickerNote = (() => {
    if (usingLive && !selectedInLive && typed && !stillTyping) {
      return "This endpoint did not list that id — it will reject it unless it really serves it.";
    }
    if (!checked) return "Checking the catalogue…";
    if (match) {
      return details ? `${match.name} · ${describeCatalogModel(match)}` : match.name;
    }
    return "Not in models.dev — it will still work, but context window and pricing stay unknown.";
  })();

  return (
    <div className="space-y-1.5">
      <Combobox
        aria-label={ariaLabel}
        items={usingLive ? liveItems : items}
        value={value}
        inputValue={inputValue}
        placeholder={placeholder}
        emptyMessage={searching ? "Searching…" : "No models.dev match — type the id and it still works"}
        disabled={disabled}
        onInputValueChange={(next, reason) => {
          // "none" is Base UI resyncing its own state, which it does when the
          // filtered list no longer contains the selection. That is not the user
          // clearing the field, so the chosen model id must survive it.
          if (reason === "none") return;
          setInputValue(next);
          onChange(next);
        }}
        onValueChange={(next) => {
          // Only a real selection changes the value. Emptying the items while a
          // new provider's search runs must not clear the chosen model id.
          if (!next) return;
          setInputValue(next);
          onChange(next);
        }}
      />
      <p className="text-sm text-ink-muted" data-testid="model-catalog-note">
        {pickerNote}
      </p>
      {details && live?.note ? (
        <p className="text-sm text-ink-faint" data-testid="model-source-note">
          {live.note}
        </p>
      ) : null}
    </div>
  );
}

function describeChoice(model: { id: string; contextWindow: number | null; pricing: { input?: number; output?: number } | null }): string {
  const bits: string[] = [];
  const context = compactTokens(model.contextWindow);
  if (context) bits.push(`${context} context`);
  if (model.pricing?.input !== undefined) bits.push(`$${model.pricing.input}/M in`);
  if (model.pricing?.output !== undefined) bits.push(`$${model.pricing.output}/M out`);
  if (!model.pricing) bits.push("no price");
  return bits.join(" · ") || "listed by the endpoint";
}
