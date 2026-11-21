/**
 * Captures the computer-use proof as an image for the pull request.
 *
 * Not a test: it drives a real box, does the UI task, and writes one PNG of the
 * filtered Thunar window that the PR cites as evidence. Run it by hand:
 *
 *   CUA_LIVE=1 npx tsx packages/cua/scripts/capture-proof.mts
 */
import { writeFileSync } from "node:fs";
import { InstaboxProvider } from "@terabot/computers";
import {
  CuaDriver,
  execTargetFor,
  launchApp,
  observeWindow,
  prepareBrowser,
  browserNavigate,
  browserState,
  readPage,
  runSteps,
  screenshot,
} from "../src/index.ts";

const apiKey = process.env.INSTABOX_API_KEY;
if (!apiKey) throw new Error("INSTABOX_API_KEY is required");

const provider = new InstaboxProvider({ account: "instabox:proof", apiKey });
const box = await provider.provision({ ttlSeconds: 1800, metadata: { "terabot-proof": "cua" } });

try {
  const client = (
    provider as unknown as {
      client: { desktop: (id: string, body: object, options?: object) => Promise<{ installed: boolean; running: boolean }> };
    }
  ).client;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.desktop(box.id, { action: "start", width: 1280, height: 800 }, { timeoutMs: 180_000 });
    if (status.installed && status.running) break;
    if (!status.installed) await client.desktop(box.id, { action: "install" }, { timeoutMs: 180_000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await provider.exec(
    box,
    [
      "export PATH=\"$HOME/.local/bin:$PATH\"",
      "if ! command -v cua-driver >/dev/null 2>&1; then",
      "  curl -fsSL https://cua.ai/driver/install.sh -o /tmp/i.sh",
      "  CUA_DRIVER_NO_CONNECT=1 CUA_DRIVER_NO_TEST=1 bash /tmp/i.sh >/dev/null 2>&1",
      "fi",
      "mkdir -p /tmp/proof && rm -f /tmp/proof/*",
      "for f in alpha beta gamma delta; do echo \"$f\" > /tmp/proof/$f.txt; done",
      "cua-driver --version",
    ].join("\n"),
    { timeoutSeconds: 300 },
  );

  const driver = new CuaDriver(execTargetFor(provider, box), { session: "proof" });
  await driver.ensureReady();

  const launched = await launchApp(driver, { app: "thunar", urls: ["/tmp/proof"] });
  const window = launched.windows[0]!;
  const target = { pid: window.pid, windowId: window.windowId };

  await runSteps(driver, {
    target,
    steps: [
      { tool: "hotkey", args: { keys: ["ctrl", "f"] } },
      { tool: "type_text", args: { text: "alpha" }, expect: [{ text: "alpha.txt" }] },
    ],
    observe: { screenshot: false },
    foregroundFallback: true,
  });

  const observed = await observeWindow(driver, target);
  const shot = await screenshot(driver, target);
  writeFileSync("cua-ui-proof.png", Buffer.from(shot.data, "base64"));
  console.log(`ui proof: ${observed.elements.length} rows, alpha present: ${
    observed.elements.some((element) => (element.label ?? "").includes("alpha"))
  }`);

  // The browser half, for a second image.
  const prepared = await prepareBrowser(driver, { profile: { mode: "isolated_named", name: "proof" } });
  const windows = await driver.call("list_windows", { app: "chromium" });
  const browserWindow = (windows.value?.windows as Array<{ pid: number; window_id: number }> | undefined)?.find(
    (entry) => entry.pid === prepared.pid,
  );
  if (browserWindow) {
    const bound = await browserState(driver, { window: { pid: browserWindow.pid, windowId: browserWindow.window_id } });
    if ("targetId" in bound) {
      await browserNavigate(driver, {
        targetId: bound.targetId,
        tabId: bound.tabId,
        url: "https://example.com",
      });
      const page = await readPage(driver, { targetId: bound.targetId, tabId: bound.tabId, screenshot: true });
      if (page.screenshot) writeFileSync("cua-browser-proof.png", Buffer.from(page.screenshot.data, "base64"));
      console.log(`browser proof: title=${page.title} gated=${page.captcha.gated} outline=${page.outline.length} chars`);
    }
  }
} finally {
  await provider.destroy(box).catch(() => undefined);
}
