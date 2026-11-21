import { billingSummary, customerPortalUrl, refreshFromPolar, startCheckout } from "@terabot/billing";
import { redirect } from "next/navigation";
import { requireUser } from "../../../lib/session.ts";

/**
 * Settings → Billing. This is where a gate notice sends the person, so it has
 * to be a real page with a working button — not a tab that says "coming soon".
 *
 * With Polar unconfigured it says so plainly instead of offering a checkout
 * that cannot work.
 */
export const dynamic = "force-dynamic";

/** The repair action for a failed payment, as opposed to buying a new plan. */
async function openPortal(): Promise<void> {
  "use server";
  const user = await requireUser();
  const url = await customerPortalUrl(user.id);
  if (!url) throw new Error("There is no Polar customer to open a portal for yet.");
  redirect(url);
}

async function subscribe(formData: FormData): Promise<void> {
  "use server";
  const user = await requireUser();
  const planId = String(formData.get("planId") ?? "");
  const result = await startCheckout({ userId: user.id, email: user.email, planId });
  redirect(result.url);
}

export default async function BillingSettings() {
  const user = await requireUser();
  // Someone returning from checkout has already paid; the webhook may still be
  // in flight, so ask Polar directly before drawing the page. A failure here is
  // not fatal: the webhook remains the durable path.
  await refreshFromPolar(user.id).catch((error: unknown) => {
    console.warn("[billing] could not refresh from Polar:", error instanceof Error ? error.message : error);
  });
  const summary = await billingSummary(user.id);
  const active = summary.status === "active" || summary.status === "trialing";
  const plan = summary.plans.find((entry) => entry.id === summary.planId) ?? null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[680px] flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Billing</h1>
        <p className="mt-2 text-body text-ink-secondary">
          A plan pays for the cloud computer your bots work on. Nothing is charged until you choose one.
        </p>
      </div>

      <section className="rounded-lg border border-card bg-raised px-4 py-4">
        <p className="text-body text-ink">Current plan</p>
        {active && plan ? (
          <p className="mt-1 text-body text-ink-secondary">
            {plan.label}
            {summary.currentPeriodEnd
              ? ` · renews ${summary.currentPeriodEnd.toISOString().slice(0, 10)}`
              : ""}
            {summary.cancelAtPeriodEnd ? " · cancels at the end of this period" : ""}
          </p>
        ) : summary.status === "incomplete" ? (
          <p className="mt-1 text-body text-ink-secondary">
            A checkout was started but never finished. Nothing is charged; choose a plan below to try again.
          </p>
        ) : summary.status === "past_due" || summary.status === "unpaid" ? (
          <>
            <p className="mt-1 text-body text-ink-secondary">
              The last payment did not go through. Updating the card restores access straight away; you do not need a
              second plan.
            </p>
            <form action={openPortal} className="mt-3">
              <button
                type="submit"
                className="h-9 rounded-pill bg-ink px-4 text-base font-medium text-canvas"
              >
                Update payment method
              </button>
            </form>
          </>
        ) : (
          <p className="mt-1 text-body text-ink-secondary">No plan yet.</p>
        )}
      </section>

      {!summary.configured ? (
        <section className="rounded-lg border border-card bg-raised px-4 py-4">
          <p className="text-body text-ink">Billing is not set up on this deployment.</p>
          <p className="mt-1 text-body text-ink-secondary">
            So nothing is charged and nothing is blocked: the app is free to use as it stands. This page fills in
            once the operator sets <span className="font-mono">POLAR_ACCESS_TOKEN</span>,{" "}
            <span className="font-mono">POLAR_WEBHOOK_SECRET</span> and <span className="font-mono">POLAR_PLANS</span>.
          </p>
        </section>
      ) : active ? null : (
        <section className="flex flex-col gap-3">
          {summary.plans.map((entry) => (
            <form key={entry.id} action={subscribe} className="rounded-lg border border-card bg-raised px-4 py-4">
              <input type="hidden" name="planId" value={entry.id} />
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-body text-ink">{entry.label}</p>
                  {entry.description ? (
                    <p className="mt-1 text-body text-ink-secondary">{entry.description}</p>
                  ) : null}
                  {entry.id === summary.planId ? (
                    <p className="mt-1 text-base text-ink-muted">This is the plan you picked last time.</p>
                  ) : null}
                </div>
                <button
                  type="submit"
                  className="h-9 shrink-0 rounded-pill bg-ink px-4 text-base font-medium text-canvas"
                >
                  Choose {entry.label}
                </button>
              </div>
            </form>
          ))}
          <p className="text-base text-ink-muted">
            Payment and receipts happen on Polar&apos;s checkout page. You come back here when it finishes.
          </p>
        </section>
      )}

      <a href="/" className="text-base text-ink-secondary underline">
        Back to the app
      </a>
    </main>
  );
}
