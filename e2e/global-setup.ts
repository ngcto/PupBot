import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PID_FILE = join(process.cwd(), "e2e", ".worker.pid");

/**
 * The worker is a process with no port to poll, so it is started here and
 * stopped in global teardown; waiting for its first log line is the readiness
 * signal.
 */
export default async function globalSetup() {
  const child = spawn("pnpm", ["--filter", "@terabot/worker", "dev"], {
    cwd: process.cwd(),
    // The suite's computers come from the fake pool: a live provider key in the
    // developer's environment would spend real quota and its capacity limit would
    // make the smoke test flaky.
    env: { ...process.env, INSTABOX_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  writeFileSync(PID_FILE, String(child.pid ?? ""));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the worker did not start in 60s")), 60_000);
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("worker listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the worker exited with ${code}: ${output.slice(-800)}`));
    });
  });

  child.unref();
}
