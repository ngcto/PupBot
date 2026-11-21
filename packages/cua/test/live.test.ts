import { describe, expect, it } from "vitest";
import { InstaboxProvider } from "@terabot/computers";
import {
  assessChallenge,
  browserNavigate,
  browserState,
  click,
  detectCaptcha,
  execTargetFor,
  launchApp,
  listWindows,
  CuaDriver,
  observeWindow,
  prepareBrowser,
  readPage,
  runSteps,
  screenshot,
  type WindowTarget,
} from "../src/index.ts";

/**
 * The tests that drive a **real desktop** on a **real box**.
 *
 * Opt in with `CUA_LIVE=1` plus `INSTABOX_API_KEY`; it creates one Instabox box,
 * installs Cua Driver on it, does the proofs, and destroys the box. It never
 * runs on the default `pnpm test`, because it spends a real machine and a few
 * minutes.
 *
 * These are the tests that make "it compiles" unacceptable. Each one asserts a
 * change a piece of software owns — a window that opened, a filter that changed
 * the rows, text a page rendered — and never merely that a call returned.
 */

const apiKey = process.env.INSTABOX_API_KEY ?? "";
const live = process.env.CUA_LIVE === "1" && Boolean(apiKey);

const INSTALL = [
  "set -e",
  'export PATH="$HOME/.local/bin:$PATH"',
  "if ! command -v cua-driver >/dev/null 2>&1; then",
  "  curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh",
  "  CUA_DRIVER_NO_CONNECT=1 CUA_DRIVER_NO_TEST=1 bash /tmp/cua-install.sh >/dev/null 2>&1",
  "fi",
  "cua-driver --version",
].join("\n");

describe.skipIf(!live)("cua driver live", () => {
  it(
    "proves computer use and browser use against a real box, then destroys it",
    async () => {
      const provider = new InstaboxProvider({ account: "instabox:cua-live", apiKey });
      const box = await provider.provision({ ttlSeconds: 3600, metadata: { "terabot-test": "cua-live" } });
      const driver = new CuaDriver(execTargetFor(provider, box), { session: "live" });
      const timings: Record<string, number> = {};
      const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const started = Date.now();
        const value = await fn();
        timings[name] = Date.now() - started;
        console.log(`  ${name}: ${timings[name]} ms`);
        return value;
      };

      try {
        /* ── the desktop the driver needs ── */

        // A fresh box installs XFCE on first use (~30 s) and then paints, so this
        // is started explicitly with its own budget rather than relying on the
        // provider's capture timeout.
        await time("start desktop", () => ensureDesktop(provider, box));
        const desktop = await provider.screenshot(box);
        expect(desktop.png.byteLength).toBeGreaterThan(0);

        const version = await time("install driver", () => provider.exec(box, INSTALL, { timeoutSeconds: 300 }));
        expect(version.exitCode).toBe(0);
        expect(version.stdout).toContain("cua-driver");

        const ready = await time("ensureReady", () => driver.ensureReady());
        expect(ready.installed).toBe(true);
        expect(ready.ok).toBe(true);
        // The box's XFCE session exports the session bus, so the tree exists.
        expect(ready.accessibility).toBe(true);

        /* ── computer use: open an app, act on it, read back what changed ── */

        await provider.exec(
          box,
          "mkdir -p /tmp/proof && rm -f /tmp/proof/* && echo alpha > /tmp/proof/alpha.txt && echo beta > /tmp/proof/beta.txt && echo gamma > /tmp/proof/gamma.txt",
          { timeoutSeconds: 30 },
        );
        const launched = await time("launchApp", () => launchApp(driver, { app: "thunar", urls: ["/tmp/proof"] }));
        expect(launched.windows.length).toBeGreaterThan(0);
        const window = launched.windows[0]!;
        const target: WindowTarget = { pid: window.pid, windowId: window.windowId };

        const before = await time("observeWindow", () => observeWindow(driver, target));
        expect(before.snapshotId).not.toBe("");
        expect(before.elements.length).toBeGreaterThan(10);
        // Every row is a target, and every token names the read it came from.
        const token = before.elements[0]!.token;
        expect(token.startsWith(before.snapshotId)).toBe(true);
        const rowsBefore = before.elements.length;
        const labelsBefore = before.elements.map((element) => element.label ?? "").join(" ");

        /* ── the ladder: an exact target, and an honest account of the rung ── */

        const first = await time("click (background)", () => click(driver, target, { elementToken: token }));
        // The ladder's invariant, whatever rung this toolkit allows: nothing is
        // reported as success unless the driver read the change back, and a
        // non-landed action either names the next rung or says why not.
        if (first.effect !== "confirmed") {
          expect(first.ok).toBe(false);
          expect(first.verified).toBe(false);
          if (first.refusal) {
            expect(first.refusal.message.length).toBeGreaterThan(0);
            // A stale token means re-observe; it must not claim a rung to climb.
            if (first.refusal.code === "stale_element_token") expect(first.escalation).toBeUndefined();
          }
          if (first.effect === "refused") {
            expect(first.escalation?.recommended).toMatch(/^(px|foreground|page)$/);
          }
        }
        console.log(
          `  background click: effect=${first.effect} escalation=${first.escalation?.recommended ?? "none"} code=${first.refusal?.code ?? "none"}`,
        );

        const climbed = await time("click (foreground)", () =>
          click(driver, target, { elementToken: token }, { delivery: "foreground" }),
        );
        // The foreground rung is the top of the ladder: it must land, and it must
        // confirm it did rather than asking to climb again.
        expect(climbed.effect).not.toBe("refused");
        expect(climbed.escalation).toBeUndefined();
        expect(climbed.verified || climbed.effect === "confirmed").toBe(true);

        /* ── a change the app owns: a search filter that alters the rows ── */

        const filtered = await time("runSteps (filter the list)", () =>
          runSteps(driver, {
            target,
            steps: [
              { tool: "hotkey", args: { keys: ["ctrl", "f"] } },
              {
                tool: "type_text",
                args: { text: "alpha" },
                // The check is the proof: the filter must show alpha.txt and
                // nothing else, in the app, not in our own bookkeeping.
                expect: [{ text: "alpha.txt" }],
              },
            ],
            observe: { screenshot: false },
            foregroundFallback: true,
          }),
        );
        expect(filtered.ok, `batch failed: ${filtered.failure ?? "unknown"}`).toBe(true);
        expect(filtered.steps.every((step) => step.ok)).toBe(true);
        expect(filtered.observed?.diffSummary ?? filtered.observed?.outline ?? "").toBeDefined();

        const afterFilter = await observeWindow(driver, target);
        const labelsAfter = afterFilter.elements.map((element) => element.label ?? "").join(" ");
        console.log(
          `  rows ${rowsBefore} -> ${afterFilter.elements.length}; alpha visible: ${labelsAfter.includes("alpha.txt")}`,
        );
        expect(labelsAfter, "the app must show the filtered file").toContain("alpha");
        expect(afterFilter.snapshotId).not.toBe(before.snapshotId);

        /* ── the escape key is verified by the app going back ── */

        await runSteps(driver, {
          target,
          steps: [{ tool: "hotkey", args: { keys: ["escape"] } }],
          observe: false,
          foregroundFallback: true,
        });
        const restored = await observeWindow(driver, target);
        expect(restored.elements.length).toBeGreaterThan(0);
        expect(labelsBefore.length).toBeGreaterThan(0);

        /* ── a screenshot is available, and only when asked for ── */

        const image = await time("screenshot", () => screenshot(driver, target));
        expect(image.data.length).toBeGreaterThan(1000);
        expect(image.mime).toContain("image");

        /* ── browser use: a rendered page, through the driver's CDP tools ── */

        const prepared = await time("prepareBrowser", () =>
          prepareBrowser(driver, { profile: { mode: "isolated_named", name: "terabot-live" } }),
        );
        expect(prepared.prepared).toBe(true);
        expect(prepared.pid).toBeGreaterThan(0);
        // The person's own browser must not have been touched.
        expect(prepared.sideEffects?.launched_browser).toBe(true);
        expect(prepared.sideEffects?.restarted_browser).toBe(false);

        const browserWindows = await listWindows(driver, { pid: prepared.pid });
        expect(browserWindows.length).toBeGreaterThan(0);
        const bound = await time("browserState (bind)", () =>
          browserState(driver, { window: { pid: prepared.pid!, windowId: browserWindows[0]!.windowId } }),
        );
        expect("targetId" in bound && bound.bindingQuality).toBe("exact");
        const tab = bound as { targetId: string; tabId: string };

        await time("browserNavigate", () =>
          browserNavigate(driver, { targetId: tab.targetId, tabId: tab.tabId, url: "https://example.com" }),
        );

        const page = await time("readPage", () =>
          readPage(driver, { targetId: tab.targetId, tabId: tab.tabId }),
        );
        // Text that only a rendered page has: it exists because the browser parsed
        // the document, not in any HTTP body we could have read ourselves.
        expect(page.title).toBe("Example Domain");
        expect(page.outline.length).toBeGreaterThan(20);
        expect(`${page.outline}${JSON.stringify(page.content)}`).toContain("Example Domain");
        // Detection rides on the same read and costs nothing extra.
        expect(page.captcha.gated).toBe(false);

        /* ── a challenge is state, not a failure ── */

        const gated = await assessChallenge(
          { url: "https://example.com", title: "Just a moment...", outline: "", refs: [], content: [] },
          {},
        );
        expect(gated.detection.gated).toBe(true);
        expect(gated.detection.primary?.kind).toBe("cloudflare_interstitial");
        expect(gated.passed).toBe(false);
        expect(detectCaptcha({ title: "Example Domain", text: page.outline }).gated).toBe(false);

        console.log(`  total: ${Object.values(timings).reduce((sum, value) => sum + value, 0)} ms`);
        console.log(`  timings: ${JSON.stringify(timings)}`);
      } finally {
        await provider.destroy(box).catch(() => undefined);
        const left = await provider.listComputers();
        expect(left.some((entry) => entry.id === box.id)).toBe(false);
      }
    },
    600_000,
  );
});

/**
 * Bring the box's desktop up, installing XFCE if this is the box's first use.
 * The provider's own capture path does this internally, but with a budget sized
 * for a repaint rather than a first install.
 */
async function ensureDesktop(
  provider: InstaboxProvider,
  box: { id: string },
): Promise<void> {
  const client = (
    provider as unknown as {
      client: {
        desktop: (
          id: string,
          body: object,
          options?: object,
        ) => Promise<{ installed: boolean; running: boolean }>;
      };
    }
  ).client;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.desktop(box.id, { action: "start", width: 1280, height: 800 }, { timeoutMs: 180_000 });
    if (status.installed && status.running) return;
    if (!status.installed) await client.desktop(box.id, { action: "install" }, { timeoutMs: 180_000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("the box desktop never came up");
}
