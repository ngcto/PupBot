"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  ComputerIcon,
  Delete02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import {
  Button,
  Input,
  Select,
  cn,
  toast,
} from "@terabot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  connectComputerAccount,
  disconnectComputerAccount,
} from "../app/actions.ts";
import type { ComputerAccountView, ProviderAvailability } from "../lib/types.ts";

/**
 * Settings > Computer.
 *
 * The simple case first: a deployment that lends computers shows one line
 * saying so, and the user never sees a key field. Everything technical — the
 * provider kind, the account's id, its capacity and its box count — is behind
 * Advanced, because a person who just wants a bot that works should not have to
 * learn what an allocator is.
 *
 * A user may still bring their own key, which then outranks the deployment's
 * for their own bots. One account per provider: the picker drops a provider
 * they already connected rather than letting them save a duplicate that the
 * database would refuse.
 */
export function ComputerPanel({
  accounts,
  providers,
  role,
}: {
  accounts: ComputerAccountView[];
  providers: ProviderAvailability[];
  /** A member does not configure a provider: managed cloud comes with the plan. */
  role: "owner" | "member";
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const managed = accounts.filter((account) => account.managed);
  const mine = accounts.filter((account) => !account.managed);
  const connectable = providers.filter((provider) => provider.canConnect);

  async function remove(account: ComputerAccountView) {
    setBusy(account.id);
    try {
      await disconnectComputerAccount(account.id);
      toast("Computer disconnected");
      router.refresh();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The computer could not be disconnected");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="computer-panel">
      <p className="mt-3 max-w-[560px] text-body text-ink-secondary">
        Every bot runs on its own cloud computer. It starts when a bot first needs it and goes to sleep
        when it is idle, so there is nothing to run yourself.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg bg-raised" data-testid="computer-account-list">
        {managed.length === 0 && mine.length === 0 ? (
          <div className="px-4 py-6" data-testid="computer-empty">
            <p className="text-body text-ink">No computer available.</p>
            <p className="mt-1 text-body text-ink-secondary">
              This deployment does not provide computers. Connect your own Instabox or Agent37 key below and
              your bots can start working.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {[...managed, ...mine].map((account) => (
              <AccountRow key={account.id} account={account} busy={busy === account.id} onRemove={remove} />
            ))}
          </div>
        )}
      </div>

      {role === "member" ? (
        <div className="mt-4 max-w-[560px] rounded-sm border border-card bg-raised-2 px-3 py-2.5" data-testid="computer-readonly">
          <p className="text-base text-ink">Managed cloud comes with your plan.</p>
          <p className="mt-1 text-base text-ink-muted">
            You do not configure a computer here — your bots use the ones the deployment provides. Adding your own{" "}
            <span className="text-ink-secondary">model</span> provider is separate and still yours to do, under
            Providers.
          </p>
        </div>
      ) : null}

      <div className={role === "member" ? "mt-4 hidden" : "mt-4 flex items-center gap-2"}>
        {connectable.length === 0 ? (
          <p className="text-sm text-ink-faint" data-testid="computer-no-more-providers">
            You have connected every provider this deployment supports.
          </p>
        ) : adding ? null : (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)} data-testid="computer-connect">
            Connect my own computer
          </Button>
        )}
      </div>

      {adding ? (
        <ConnectForm
          providers={connectable}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function AccountRow({
  account,
  busy,
  onRemove,
}: {
  account: ComputerAccountView;
  busy: boolean;
  onRemove: (account: ComputerAccountView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const full = account.used >= account.capacity;
  const broken = account.status === "error";
  const draining = account.status === "draining";
  const parked = account.parkedUntil !== null && Date.parse(account.parkedUntil) > Date.now();
  // A legacy or seed row is visible to every user but belongs to none of them,
  // so there is nobody who may disconnect it. Showing "Yours" with a button that
  // always rejects would be a control that cannot work.
  const unowned = account.ownerUserId === null;

  return (
    <div className="px-4 py-3" data-testid={`computer-account-${account.id}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-body font-medium text-ink">
            <HugeiconsIcon icon={ComputerIcon} size={15} strokeWidth={1.7} className="text-ink-secondary" />
            {account.label}
            <span className="rounded-pill bg-raised-3 px-2 py-0.5 text-sm text-ink-muted">
              {account.managed ? "Included" : unowned ? "Deployment" : "Yours"}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            {broken
              ? (account.lastError ?? "This computer was refused by the provider.")
              : draining
                ? "No new bots start here. Its boxes finish their work first."
                : parked
                  ? "The provider asked us to wait before using this computer again."
                  : full
                    ? account.capacity === 1
                      ? "One bot at a time, and it stays taken until that bot's box is deleted."
                      : `All ${account.capacity} places are taken until those bots' boxes are deleted.`
                    : "Ready when a bot needs it."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {broken ? (
            <Status text="Needs attention" tone="danger" />
          ) : draining ? (
            <Status text="Draining" tone="muted" />
          ) : parked ? (
            <Status text="Waiting" tone="muted" />
          ) : full ? (
            <Status text="In use" tone="muted" />
          ) : (
            <Status text="Ready" tone="success" />
          )}
          {/* Nothing here a user may remove: a managed computer belongs to the
              deployment, and an unowned row belongs to no one. The control is
              absent rather than disabled, so there is nothing to press. */}
          {account.managed || unowned ? null : confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onRemove(account)}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Disconnect ${account.label}`}
              onClick={() => setConfirming(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.7} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectForm({
  providers,
  onCancel,
  onSaved,
}: {
  providers: ProviderAvailability[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(providers[0]?.provider ?? "instabox");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hint =
    provider === "agent37"
      ? "Paste an Agent37 key from agent37.com → Dashboard → API keys. Its workspace needs a funded wallet."
      : provider === "boat"
        ? "Paste a Boat key from boat.dev → Dashboard → API keys."
        : "Paste an Instabox key from instabox.dev → Dashboard → API keys.";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await connectComputerAccount({ provider, apiKey });
      toast("Computer connected");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg bg-raised px-4 py-4" data-testid="computer-connect-form">
      <p className="text-body font-medium text-ink">Connect your own computer</p>
      <p className="mt-1 max-w-[520px] text-sm text-ink-muted">
        Your key stays on the server, encrypted. Your bots use your computer first and only fall back to the
        included one when yours is busy.
      </p>

      <label className="mt-4 block text-sm text-ink-secondary" htmlFor="computer-provider">
        Provider
      </label>
      <Select
        className="mt-1"
        value={provider}
        onValueChange={setProvider}
        options={providers.map((entry) => ({ value: entry.provider, label: entry.label }))}
      />

      <label className="mt-3 block text-sm text-ink-secondary" htmlFor="computer-key">
        API key
      </label>
      <Input
        id="computer-key"
        type="password"
        autoComplete="off"
        className="mt-1"
        placeholder="sk_…"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <p className="mt-1 text-sm text-ink-faint">{hint} It is never shown again after saving.</p>

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-danger" role="alert">
          <HugeiconsIcon icon={Alert02Icon} size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={saving || !apiKey.trim()} onClick={() => void save()}>
          {saving ? "Saving…" : "Save key"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Status({ text, tone }: { text: string; tone: "success" | "muted" | "danger" }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm",
        tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink-muted",
      )}
    >
      <HugeiconsIcon
        icon={tone === "danger" ? Alert02Icon : tone === "success" ? CheckmarkCircle02Icon : InformationCircleIcon}
        size={13}
        strokeWidth={1.8}
      />
      {text}
    </span>
  );
}
