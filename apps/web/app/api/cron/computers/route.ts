import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@terabot/computers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The hosted deployment has no `apps/worker`, so nothing ran the maintenance
 * tick: idle boxes were never slept, ownerless ones were never destroyed, and a
 * binding whose request died was never retried.
 *
 * Once a day, not once a minute: a Hobby Vercel account refuses any cron that
 * runs more than daily, and a rejected schedule fails the whole deployment. Every
 * step here is idempotent, so the cadence only sets how long a leaked box keeps
 * booking capacity — and the volume that needs reclaiming on this deployment is
 * small and slow.
 */
export async function GET(request: Request): Promise<Response> {
  // Fails closed: this endpoint sleeps boxes and tears down ownerless ones, so a
  // deployment that forgot CRON_SECRET must refuse every caller rather than let
  // anyone on the internet trigger it.
  const secret = serverEnv().CRON_SECRET;
  if (!secret) return new Response("cron is not configured", { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const allocator = new ComputerAllocator({
    store: new DrizzleComputerStore(),
    providers: createProviderFactory(),
  });

  const sweep = await allocator.sweepIdle();
  const leases = await allocator.renewLeases();
  const stalled = await allocator.retryStalledBindings();

  // No `reconcile` here on purpose: it enumerates the provider's inventory and
  // marks any row the provider does not have as deleted. A provider that cannot
  // list (the fake keeps its boxes in one process' memory) would read as an
  // empty account and delete the whole pool by row. `sweepIdle` already destroys
  // boxes whose bot is gone, which is the case this deployment actually leaks.
  return Response.json({ sweep, leases, stalled });
}
