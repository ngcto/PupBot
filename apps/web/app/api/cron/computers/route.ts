import { serverEnv } from "@terabot/config";
import { ComputerAllocator, DrizzleComputerStore, createProviderFactory } from "@terabot/computers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The hosted deployment has no `apps/worker`, so nothing ran the maintenance
 * tick: idle boxes were never slept, ownerless ones were never destroyed, and a
 * binding whose request died was never retried. Vercel calls this on the same
 * one-minute cadence the worker used.
 *
 * Every step here is idempotent, so a missed tick costs nothing but delay.
 */
export async function GET(request: Request): Promise<Response> {
  // Vercel signs its own cron calls with CRON_SECRET; without that check this
  // endpoint would let anyone tear down computers.
  const secret = serverEnv().CRON_SECRET;
  const authorized = request.headers.get("authorization") === `Bearer ${secret}`;
  if (secret && !authorized) return new Response("unauthorized", { status: 401 });

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
