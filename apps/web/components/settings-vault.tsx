"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  CreditCardIcon,
  Delete02Icon,
  Edit02Icon,
  LockPasswordIcon,
  UserAccountIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { Button, Input, Select, cn, toast } from "@terabot/ui";
import { groupedValue } from "@terabot/vault/kinds";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Settings → Vault.
 *
 * The rule this component is built around: **no stored value is ever rendered**.
 * The list comes from `GET /vault`, which returns labels, domains and a masked tail
 * and nothing else — so a value cannot reach the page even by accident. A secret
 * input is only ever empty; leaving it blank on an edit keeps what is stored.
 *
 * "Show value" is the single path to a plaintext and it re-checks the account
 * password first, in the same request that fetches the value. It is not a policy
 * gate on the bot — the bot never uses this route — it is the guard against someone
 * walking up to an unlocked browser.
 */

type Kind = "login" | "card" | "contact";

interface FieldDefinition {
  name: string;
  label: string;
  input: "text" | "password" | "email" | "tel" | "number";
  secret: boolean;
  masked: boolean;
  optional: boolean;
  maxLength: number;
  hint: string | null;
  group: number[] | null;
  separator: string | null;
}

interface KindDefinition {
  kind: Kind;
  label: string;
  summary: string;
  fields: FieldDefinition[];
}

interface ItemView {
  id: string;
  kind: Kind;
  label: string;
  domain: string | null;
  hint: string | null;
  meta: Record<string, string>;
  secretFields: string[];
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const KIND_ICON: Record<Kind, typeof LockPasswordIcon> = {
  login: LockPasswordIcon,
  card: CreditCardIcon,
  contact: UserAccountIcon,
};

export function VaultPanel({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [items, setItems] = useState<ItemView[]>([]);
  const [kinds, setKinds] = useState<KindDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: Kind; item: ItemView | null } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [revealFor, setRevealFor] = useState<ItemView | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/vault`, { credentials: "include" });
      if (!response.ok) throw new Error("the vault could not be read");
      const data = (await response.json()) as { items: ItemView[]; kinds: KindDefinition[] };
      setItems(data.items);
      setKinds(data.kinds);
    } catch {
      setError("The vault could not be read. Try again.");
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(item: ItemView) {
    setConfirmDeleteId(null);
    const response = await fetch(`${apiUrl}/vault/${item.id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok) {
      toast("That item could not be deleted.");
      return;
    }
    toast(`Deleted ${item.label}`);
    void load();
    router.refresh();
  }

  const grouped = useMemo(() => {
    const order: Kind[] = ["login", "card", "contact"];
    return order
      .map((kind) => ({ kind, entries: items.filter((item) => item.kind === kind) }))
      .filter((group) => group.entries.length > 0);
  }, [items]);

  if (editing) {
    const definition = kinds.find((entry) => entry.kind === editing.kind);
    if (!definition) return null;
    return (
      <VaultForm
        apiUrl={apiUrl}
        definition={definition}
        item={editing.item}
        onDone={() => {
          setEditing(null);
          void load();
          router.refresh();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div data-testid="vault-panel">
      <p className="mt-3 max-w-[560px] text-body text-ink-secondary">
        Save a login, a card or your contact details once. Your bot uses them on its own when a task needs
        them — you will not be asked to approve each use.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {kinds.map((definition) => (
          <Button
            key={definition.kind}
            size="sm"
            variant="secondary"
            data-testid={`vault-add-${definition.kind}`}
            onClick={() => setEditing({ kind: definition.kind, item: null })}
          >
            <HugeiconsIcon icon={KIND_ICON[definition.kind]} size={15} strokeWidth={1.7} />
            Add {definition.label.toLowerCase()}
          </Button>
        ))}
      </div>

      {loading ? (
        <p className="mt-6 text-body text-ink-muted">Reading the vault…</p>
      ) : error ? (
        <div className="mt-6 rounded-lg bg-raised px-4 py-4" role="alert">
          <p className="text-body text-ink">{error}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : grouped.length === 0 ? (
        <div className="mt-6 rounded-lg bg-raised px-4 py-6" data-testid="vault-empty">
          <p className="text-body text-ink">Nothing saved yet.</p>
          <p className="mt-1 text-body text-ink-secondary">
            Values are encrypted before they touch the database, and never shown again except to you.
          </p>
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.kind} className="mt-6">
            <p className="mb-2 px-1 text-base text-ink-muted">
              {kinds.find((entry) => entry.kind === group.kind)?.label ?? group.kind}
            </p>
            <div
              className="divide-y divide-hairline overflow-hidden rounded-lg bg-raised"
              data-testid="vault-list"
              data-kind={group.kind}
            >
              {group.entries.map((item) => (
                <div key={item.id} className="px-4 py-3" data-testid={`vault-row-${item.id}`}>
                  <div className="flex items-center gap-3">
                    <HugeiconsIcon
                      icon={KIND_ICON[item.kind]}
                      size={18}
                      strokeWidth={1.7}
                      className="shrink-0 text-ink-secondary"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium text-ink">{item.label}</p>
                      <p className="mt-0.5 truncate text-sm text-ink-muted">
                        {item.kind === "contact" ? contactLine(item) : (item.domain ?? "any site")}
                        {item.hint ? <span className="ml-2 tabular text-ink-faint">{item.hint}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.secretFields.length > 0 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Show a value from ${item.label}`}
                          onClick={() => setRevealFor(item)}
                        >
                          <HugeiconsIcon icon={ViewIcon} size={15} strokeWidth={1.7} />
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${item.label}`}
                        onClick={() => setEditing({ kind: item.kind, item })}
                      >
                        <HugeiconsIcon icon={Edit02Icon} size={15} strokeWidth={1.7} />
                      </Button>
                      {confirmDeleteId === item.id ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="primary" onClick={() => void remove(item)}>
                            Delete
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${item.label}`}
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.7} />
                        </Button>
                      )}
                    </div>
                  </div>
                  {item.lastUsedAt ? (
                    <p className="mt-1 text-sm text-ink-faint">
                      Last used {new Date(item.lastUsedAt).toLocaleDateString()}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {revealFor ? (
        <RevealDialog apiUrl={apiUrl} item={revealFor} onClose={() => setRevealFor(null)} />
      ) : null}
    </div>
  );
}

function contactLine(item: ItemView): string {
  const parts = [item.meta.email, item.meta.phone].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : (item.meta.name ?? "Contact details");
}

function VaultForm({
  apiUrl,
  definition,
  item,
  onDone,
  onCancel,
}: {
  apiUrl: string;
  definition: KindDefinition;
  item: ItemView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(item?.label ?? "");
  const [domain, setDomain] = useState(item?.domain ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    // A secret field starts empty, always: the current value is not on this page.
    const initial: Record<string, string> = {};
    for (const field of definition.fields) {
      initial[field.name] = field.secret ? "" : (item?.meta[field.name] ?? "");
    }
    return initial;
  });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A domain is required for a credential and optional for contact info.
  const needsDomain = definition.kind !== "contact";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind: definition.kind,
        label,
        domain: needsDomain ? domain : domain || null,
        values,
      };
      const response = await fetch(item ? `${apiUrl}/vault/${item.id}` : `${apiUrl}/vault`, {
        method: item ? "PATCH" : "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        setError(detail?.message ?? "That could not be saved.");
        return;
      }
      toast(item ? "Saved" : `Saved ${definition.label.toLowerCase()}`);
      onDone();
    } catch {
      setError("That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  // Required fields first, then everything optional behind one disclosure: a
  // person adding a login sees a username and a password, not a form of ten inputs.
  const primary = definition.fields.filter((field) => !field.optional);
  const secondary = definition.fields.filter((field) => field.optional);

  return (
    <div data-testid="vault-form">
      <button
        type="button"
        className="mt-2 flex items-center gap-1 text-base text-ink-secondary hover:text-ink"
        onClick={onCancel}
      >
        ← Back to the vault
      </button>

      <h3 className="mt-4 text-lg font-semibold text-ink">
        {item ? "Edit" : "Add"} {definition.label.toLowerCase()}
      </h3>
      <p className="mt-1 max-w-[520px] text-body text-ink-secondary">{definition.summary}</p>

      <div className="mt-4 max-w-[520px] space-y-3">
        <Field label={item ? "Name" : "Name"} htmlFor="vault-label">
          <Input
            id="vault-label"
            value={label}
            placeholder={definition.kind === "login" ? "GitHub" : definition.kind === "card" ? "Personal card" : "Home"}
            onChange={(event) => setLabel(event.target.value)}
            data-testid="vault-label"
          />
        </Field>

        {(needsDomain || advanced) && (
          <Field
            label="Site"
            htmlFor="vault-domain"
            hint={
              needsDomain
                ? "The site this belongs to. Your bot only uses it there."
                : "Optional. Without it, the bot may fill it on any site."
            }
          >
            <Input
              id="vault-domain"
              value={domain}
              placeholder="github.com"
              autoComplete="off"
              onChange={(event) => setDomain(event.target.value)}
              data-testid="vault-domain"
            />
          </Field>
        )}

        {primary.map((field) => (
          <VaultFieldInput
            key={field.name}
            field={field}
            kind={definition.kind}
            item={item}
            value={values[field.name] ?? ""}
            onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
          />
        ))}

        {secondary.length > 0 ? (
          <div className="pt-1">
            <button
              type="button"
              className="flex items-center gap-1 text-base text-ink-secondary hover:text-ink"
              onClick={() => setAdvanced((open) => !open)}
              data-testid="vault-advanced"
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={14}
                strokeWidth={1.7}
                className={cn("transition-transform", advanced && "rotate-180")}
              />
              Advanced
            </button>
            {advanced ? (
              <div className="mt-3 space-y-3">
                {secondary.map((field) => (
                  <VaultFieldInput
                    key={field.name}
                    field={field}
                    kind={definition.kind}
                    item={item}
                    value={values[field.name] ?? ""}
                    onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 max-w-[520px] text-sm text-danger" role="alert" data-testid="vault-form-error">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()} data-testid="vault-save">
          {busy ? "Saving…" : item ? "Save changes" : "Save to vault"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function VaultFieldInput({
  field,
  kind,
  item,
  value,
  onChange,
}: {
  field: FieldDefinition;
  kind: Kind;
  item: ItemView | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const kept = item?.secretFields.includes(field.name) ?? false;
  return (
    <Field
      label={field.label}
      htmlFor={`vault-${field.name}`}
      hint={
        field.secret && kept
          ? "Saved. Leave this empty to keep it, or type a new value to replace it."
          : (field.hint ?? undefined)
      }
    >
      <Input
        id={`vault-${field.name}`}
        // A password field never holds a value the browser could autofill from
        // somewhere else, and a write-only field must not offer to.
        type={field.masked ? "password" : field.input === "number" ? "text" : field.input}
        name={field.name}
        value={value}
        maxLength={field.maxLength + (field.group ? 6 : 0)}
        placeholder={field.secret && kept ? "••••••••" : undefined}
        autoComplete={field.masked ? "new-password" : "off"}
        inputMode={field.input === "number" || field.input === "tel" ? "numeric" : undefined}
        onChange={(event) => {
          // Grouping is presentation; the server strips whatever separator is typed.
          onChange(groupedValue(event.target.value, field.group, field.separator ?? undefined));
        }}
        data-testid={`vault-field-${kind}-${field.name}`}
      />
    </Field>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm text-ink-secondary">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-sm text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * Showing a stored value, and the one place a browser ever holds one.
 *
 * The password is re-checked server-side in the same request that returns the
 * value, so the client never holds a plaintext it did not just prove it is allowed
 * to see. The value is put in an input the person can read, cleared on close, and
 * never written to state that outlives this dialog.
 */
function RevealDialog({ apiUrl, item, onClose }: { apiUrl: string; item: ItemView; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [value, setValue] = useState<string | null>(null);
  const [field, setField] = useState(item.secretFields[0] ?? "password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/vault/${item.id}/reveal`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, field }),
      });
      if (response.status === 401) {
        setError("That password is not right.");
        return;
      }
      if (!response.ok) {
        setError("That value could not be read.");
        return;
      }
      const data = (await response.json()) as { values: Record<string, string> };
      setValue(data.values[field] ?? null);
    } catch {
      setError("That value could not be read.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 max-w-[520px] rounded-lg border border-dialog-edge bg-raised px-4 py-4" data-testid="vault-reveal">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-body font-medium text-ink">Show {item.label}</p>
          <p className="mt-1 text-sm text-ink-muted">
            Confirm your account password to see the stored value. It is shown once and not saved in the page.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      {item.secretFields.length > 1 ? (
        <div className="mt-3">
          <Select
            value={field}
            onValueChange={(next) => {
              setField(next);
              setValue(null);
            }}
            options={item.secretFields.map((name) => ({ value: name, label: name }))}
          />
        </div>
      ) : null}

      {value ? (
        <div className="mt-3 space-y-2">
          <Input readOnly value={value} type="text" data-testid="vault-revealed-value" className="font-mono" />
          <Button size="sm" variant="ghost" onClick={() => setValue(null)}>
            Hide
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Input
            type="password"
            value={password}
            placeholder="Your account password"
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            data-testid="vault-reauth"
          />
          <Button size="sm" variant="secondary" disabled={busy || !password} onClick={() => void reveal()}>
            {busy ? "Checking…" : "Show value"}
          </Button>
        </div>
      )}

      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
