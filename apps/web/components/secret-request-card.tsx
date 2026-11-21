"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CreditCardIcon,
  LockPasswordIcon,
  ShieldKeyIcon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { Button, Input, Switch, cn, toast } from "@terabot/ui";
import { groupedValue } from "@terabot/vault/kinds";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The ask-the-user card.
 *
 * A bot that needs a credential it cannot get itself asks for it here, because the
 * person chose to be in a conversation where it can happen — this is a request for
 * information, not a failure notice and not a permission gate.
 *
 * Two buttons, those two words, on every kind: **Confirm** submits what was filled
 * in and honours the checkbox, **Decline** resolves the request with no value. The
 * "Save to vault" checkbox is checked by default: a person who adds a login here
 * usually wants it to exist afterwards.
 *
 * What the component never does is hold a value past its submit. The response is
 * `{ status }` and nothing else, so there is nothing to keep; the field state is
 * cleared as soon as the request resolves, and a resolved card renders its outcome
 * rather than an editable form.
 */

type Kind = "login" | "card" | "contact";

interface CardField {
  name: string;
  label: string;
  input: "text" | "password" | "email" | "tel" | "number";
  secret: boolean;
  /** Whether the input masks typing. A stored expiry does not. */
  masked: boolean;
  optional: boolean;
  maxLength: number;
  hint: string | null;
  group: number[] | null;
  separator: string | null;
}

interface CardRequest {
  id: string;
  kind: Kind;
  reason: string;
  status: "pending" | "provided" | "declined" | "expired";
  expiresAt: string;
  open: boolean;
  /** The site it will be saved for, so the card can say where it may be used. */
  domain: string | null;
  fields: CardField[];
}

const KIND_ICON: Record<Kind, typeof LockPasswordIcon> = {
  login: LockPasswordIcon,
  card: CreditCardIcon,
  contact: UserAccountIcon,
};

const KIND_TITLE: Record<Kind, string> = {
  login: "A login",
  card: "A payment card",
  contact: "Contact details",
};

/**
 * How long the card still has, refreshed once a second so it cannot sit there
 * looking editable after its deadline.
 */
function useCountdown(expiresAt: string, active: boolean): number {
  // Starts null and is filled in after mount. The server cannot know the reader's
  // clock, so a value rendered on both sides would be a hydration mismatch by
  // construction — which is exactly what this used to be.
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    tick();
    if (!active) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, active]);
  return remaining ?? Number.POSITIVE_INFINITY;
}

/**
 * The card fetches its own question by id, from the event's slim payload.
 *
 * That is what lets the card survive a reload: the event log holds the request id,
 * and `GET /secret-requests/:id` holds the fields and the current status. It also
 * keeps the field definitions in one place — the vault's — rather than duplicated in
 * an event payload.
 */
export function SecretRequestCard({
  apiUrl,
  requestId,
  seed,
  onResolved,
}: {
  apiUrl: string;
  requestId: string;
  /** What the event carried, so the card renders the question without a round trip. */
  seed?: { kind: Kind; reason: string; domain: string | null; expiresAt: string };
  onResolved?: () => void;
}) {
  const [request, setRequest] = useState<CardRequest>({
    id: requestId,
    kind: seed?.kind ?? "login",
    reason: seed?.reason ?? "",
    domain: seed?.domain ?? null,
    expiresAt: seed?.expiresAt ?? new Date(Date.now() + 180_000).toISOString(),
    status: "pending",
    open: true,
    fields: [],
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`${apiUrl}/secret-requests/${requestId}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { request?: Omit<CardRequest, "fields">; fields?: CardField[] } | null) => {
        if (!live || !data?.request) return;
        setRequest((current) => ({
          ...current,
          ...data.request!,
          fields: data.fields ?? [],
        }));
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [apiUrl, requestId]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveToVault, setSaveToVault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expiredHandled = useRef(false);

  const remaining = useCountdown(request.expiresAt, request.status === "pending");

  // The countdown reaching zero is a local fact; the server's `expireOverdue` is the
  // authority. Render it as expired without needing a round trip.
  const timedOut = request.status === "pending" && remaining <= 0;

  useEffect(() => {
    if (!timedOut || expiredHandled.current) return;
    expiredHandled.current = true;
    void fetch(`${apiUrl}/secret-requests/${request.id}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { request?: Omit<CardRequest, "fields">; fields?: CardField[] } | null) => {
        if (data?.request) {
          setRequest((current) => ({ ...current, ...data.request!, fields: data.fields ?? current.fields }));
        }
      })
      .catch(() => undefined);
  }, [apiUrl, request.id, timedOut]);

  const resolve = useCallback(
    (next: CardRequest["status"]) => {
      setRequest((current) => ({ ...current, status: next, open: false }));
      // A resolved card keeps nothing the person typed.
      setValues({});
      onResolved?.();
    },
    [onResolved],
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/secret-requests/${request.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values, saveToVault, domain: request.domain }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(detail?.message ?? "That could not be saved.");
        return;
      }
      resolve("provided");
      toast(saveToVault ? "Saved to your vault" : "Used for this run only");
    } catch {
      setError("That could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/secret-requests/${request.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decline: true }),
      });
      if (!response.ok) {
        setError("That could not be sent.");
        return;
      }
      resolve("declined");
    } catch {
      setError("That could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const settled = request.status !== "pending" || timedOut;
  const status: CardRequest["status"] = timedOut && request.status === "pending" ? "expired" : request.status;

  return (
    <div
      className="w-full max-w-[520px] overflow-hidden rounded-lg border border-card bg-raised"
      data-testid="secret-request-card"
      data-kind={request.kind}
      data-status={status}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-pill bg-raised-3 text-ink-secondary">
          <HugeiconsIcon icon={KIND_ICON[request.kind]} size={16} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-ink">{KIND_TITLE[request.kind]}</p>
          {/* The bot's own reason, in its words: the person knows what they are asked for and why. */}
          <p className="mt-0.5 text-body text-ink-secondary" data-testid="secret-request-reason">
            {request.reason}
          </p>
          {request.domain ? (
            <p className="mt-1 text-sm text-ink-faint">
              Saved for <span className="font-mono">{request.domain}</span>
              {request.kind !== "contact" ? " · your bot only uses it there" : ""}
            </p>
          ) : null}
        </div>
      </div>

      {settled ? (
        <div className="px-4 pb-3.5 pt-3" data-testid="secret-request-outcome">
          <p className={cn("text-body", status === "provided" ? "text-success" : "text-ink-muted")}>
            {status === "provided"
              ? "Thanks — your bot has what it needs."
              : status === "declined"
                ? "Declined. Your bot will carry on without it."
                : "This request expired. Send your bot a new message to try again."}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2.5 px-4 pt-3">
            {!loaded && request.fields.length === 0 ? (
              <p className="text-body text-ink-muted">Loading…</p>
            ) : null}
            {request.fields.map((field) => (
              <div key={field.name}>
                <label htmlFor={`card-${request.id}-${field.name}`} className="mb-1 block text-sm text-ink-secondary">
                  {field.label}
                  {field.optional ? <span className="ml-1 text-ink-faint">(optional)</span> : null}
                </label>
                <Input
                  id={`card-${request.id}-${field.name}`}
                  type={field.masked ? "password" : field.input === "number" ? "text" : field.input}
                  name={field.name}
                  value={values[field.name] ?? ""}
                  maxLength={field.maxLength + (field.group ? 6 : 0)}
                  inputMode={field.input === "number" || field.input === "tel" ? "numeric" : undefined}
                  // Never let the browser autofill a stored credential over what the
                  // bot asked for, and never offer to save this one either.
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: groupedValue(event.target.value, field.group, field.separator ?? undefined),
                    }))
                  }
                  data-testid={`secret-field-${field.name}`}
                />
                {field.hint ? <p className="mt-1 text-sm text-ink-faint">{field.hint}</p> : null}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
            <label className="flex cursor-pointer items-center gap-2 text-body text-ink-secondary">
              <Switch
                checked={saveToVault}
                onCheckedChange={(next) => setSaveToVault(next)}
                data-testid="save-to-vault"
                aria-label="Save to vault"
              />
              Save to vault
            </label>
            <span className="text-sm text-ink-faint" data-testid="secret-request-countdown">
              {Number.isFinite(remaining) ? `${Math.ceil(remaining / 1000)}s` : ""}
            </span>
          </div>

          <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()} data-testid="secret-confirm">
              {busy ? "Sending…" : "Confirm"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decline()} data-testid="secret-decline">
              Decline
            </Button>
            {Object.keys(values).length === 0 ? (
              <span className="ml-auto flex items-center gap-1 text-sm text-ink-faint">
                <HugeiconsIcon icon={ShieldKeyIcon} size={13} strokeWidth={1.7} />
                Encrypted before it is stored
              </span>
            ) : null}
          </div>
        </>
      )}

      {error ? (
        <p className="px-4 pb-3.5 text-sm text-danger" role="alert" data-testid="secret-request-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A compact line for a card that is no longer open, so history stays readable. */
export function SecretRequestSummary({ kind, status }: { kind: Kind; status: CardRequest["status"] }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-card bg-raised px-3 py-2 text-sm text-ink-muted">
      <HugeiconsIcon icon={status === "declined" ? Cancel01Icon : KIND_ICON[kind]} size={14} strokeWidth={1.7} />
      {status === "provided"
        ? `You provided a ${kind === "contact" ? "contact detail" : kind}`
        : status === "declined"
          ? `You declined a request for a ${kind}`
          : `A request for a ${kind} expired`}
    </div>
  );
}

export type { CardField, CardRequest, Kind };
