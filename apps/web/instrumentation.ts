/**
 * Boot work for the web app.
 *
 * The managed computer rows a deployment lends out are made here, once per
 * process, from `INSTABOX_API_KEY` / `AGENT37_API_KEY`. Without this a fresh
 * deployment's Settings would render the "no computer available" state until
 * someone happened to click Give computer, which would tell a person their
 * deployment provides nothing when it does.
 *
 * Idempotent: an existing row is only refreshed, so a restart or several
 * processes booting together leave one row per provider.
 */
export async function register(): Promise<void> {
  // Only the Node runtime has a database connection; the edge runtime runs this
  // file too.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureComputerPool } = await import("./lib/computers.ts");
  try {
    await ensureComputerPool();
  } catch (error) {
    // A boot that cannot reach the database must still serve requests: the pool
    // is re-ensured by the allocation path, and failing here would take the
    // whole app down over a row that will be created later anyway.
    console.error("computer pool: could not ensure managed accounts on boot", error);
  }
}
