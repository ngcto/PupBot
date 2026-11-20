import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const PID_FILE = join(process.cwd(), "e2e", ".worker.pid");

export default async function globalTeardown() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid) process.kill(-pid, "SIGTERM");
    rmSync(PID_FILE, { force: true });
  } catch {
    // Already gone.
  }
}
