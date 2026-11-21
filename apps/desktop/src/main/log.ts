/** One-line diagnostics, no PII, no credentials. */
export function log(scope: string, message: string, detail?: unknown): void {
  if (detail === undefined) {
    console.log(`[terabot:${scope}] ${message}`);
    return;
  }
  console.log(`[terabot:${scope}] ${message}`, detail);
}
