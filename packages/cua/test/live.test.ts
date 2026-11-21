import { describe, expect, it } from "vitest";
import { InstaboxProvider } from "@terabot/computers";
import {
  assessChallenge,
  browserNavigate,
  browserState,
  click,
  detectCaptcha,
  execTargetFor,
  fillSecret,
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

        // Files in HOME: the folder a file manager opens by default, so the
        // listing is there without a second navigation.
        await provider.exec(
          box,
          "cd ~ && printf a > proof-alpha.txt && printf b > proof-beta.txt && printf c > proof-gamma.txt",
          { timeoutSeconds: 30 },
        );
        const launched = await time("launchApp", () => launchApp(driver, { app: "thunar" }));
        expect(launched.windows.length).toBeGreaterThan(0);
        // A cold launch can answer with the first mapped window; the one that
        // matters is the last, which is the folder window it opened.
        const window = launched.windows.at(-1)!;
        const target: WindowTarget = { pid: window.pid, windowId: window.windowId };

        const before = await time("observeWindow", async () => {
          const observed = await observeWindow(driver, target);
          const seen = observed.elements.map((element) => element.label ?? "").join(" ");
          // MEASURED: Thunar's *icon* view exposes no file rows to AT-SPI — the
          // tree has the chrome and 75 rows, and none of them is a file. The
          // list view is a real table, so the proof switches to it first.
          if (!seen.includes("proof-beta.txt")) {
            const switched = await runSteps(driver, {
              target,
              steps: [{ tool: "click", args: { role: "menu item", name: "List View" } }],
              observe: { screenshot: false },
              foregroundFallback: true,
            });
            expect(switched.ok, `could not switch to the list view: ${switched.failure ?? ""}`).toBe(true);
          }
          return waitForLabels(driver, target, ["proof-beta.txt", "proof-gamma.txt"]);
        });
        expect(before.snapshotId).not.toBe("");
        expect(before.elements.length).toBeGreaterThan(10);
        // A *file row* is the target, not the first element in the tree: the
        // first row here is the toolbar's "Open Parent" button, and clicking it
        // navigates the window out of the folder (measured — the rows become
        // the root listing and every later assertion is about the wrong place).
        const fileRow = before.elements.find((element) => element.label === "proof-beta.txt");
        expect(fileRow, "the file row must be an addressable element").toBeDefined();
        const token = fileRow!.token;
        // Every token names the read it came from.
        expect(token.startsWith(before.snapshotId)).toBe(true);
        const rowsBefore = before.elements.length;
        const labelsBefore = before.elements.map((element) => element.label ?? "").join(" ");
        // The proof only means something if the files were visible to begin with.
        expect(labelsBefore, "the folder's files must be listed before filtering").toContain("proof-beta.txt");
        expect(labelsBefore, "the folder's files must be listed before filtering").toContain("proof-gamma.txt");

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
        // The foreground rung is the top of the ladder: it is never refused for
        // want of input, and it never asks to climb again.
        expect(climbed.effect).not.toBe("refused");
        expect(climbed.escalation).toBeUndefined();
        // MEASURED: selecting a file row *can* come back `unverifiable`, because
        // the toolkit reports no state change the driver can read back; the same
        // click on a row whose selection does change the tree is `confirmed`.
        // The invariant that must hold either way is the honest one — a change
        // the driver could not read is never reported as success.
        expect(climbed.ok).toBe(climbed.verified || climbed.effect === "confirmed");
        console.log(`  foreground click: effect=${climbed.effect} ok=${climbed.ok} verified=${climbed.verified}`);

        /* ── a change the app owns: a search filter that alters the rows ── */

        const filtered = await time("runSteps (filter the list)", () =>
          runSteps(driver, {
            target,
            steps: [
              { tool: "hotkey", args: { keys: ["ctrl", "f"] } },
              {
                tool: "type_text",
                args: { text: "proof-alpha" },
                // The check is the proof: the filter must show alpha.txt and
                // nothing else, in the app, not in our own bookkeeping.
                expect: [{ text: "proof-alpha.txt" }],
              },
            ],
            observe: { screenshot: false },
            foregroundFallback: true,
          }),
        );
        expect(filtered.ok, `batch failed: ${filtered.failure ?? "unknown"}`).toBe(true);
        expect(filtered.steps.every((step) => step.ok)).toBe(true);
        // The end-of-batch observation is what proves the batch landed: it must
        // be a real diff, not an empty string.
        const diff = filtered.observed?.diffSummary ?? "";
        expect(diff.length, "the batch must report what changed").toBeGreaterThan(0);

        const afterFilter = await observeWindow(driver, target);
        const labelsAfter = afterFilter.elements.map((element) => element.label ?? "").join(" ");
        console.log(
          `  rows ${rowsBefore} -> ${afterFilter.elements.length}; alpha listed: ${labelsAfter.includes("proof-alpha.txt")}; beta excluded: ${!labelsAfter.includes("proof-beta.txt")}`,
        );
        // The strongest assertion available: the filter *excluded* the files that
        // did not match. Without this, a no-op batch passes because alpha.txt was
        // on screen all along.
        expect(labelsAfter, "the filtered file must be listed").toContain("proof-alpha.txt");
        expect(labelsAfter, "a non-matching file must be filtered out").not.toContain("proof-beta.txt");
        expect(labelsAfter, "a non-matching file must be filtered out").not.toContain("proof-gamma.txt");
        // And the search box itself now shows what was typed into it.
        const searchRow = afterFilter.elements.find(
          (element) => element.role === "text field" || /search/i.test(element.label ?? ""),
        );
        if (searchRow) console.log(`  search field now: ${JSON.stringify(String(searchRow.value ?? ""))}`);
        expect(afterFilter.snapshotId).not.toBe(before.snapshotId);

        /* ── clearing the filter is verified by the files coming back ── */

        // Clearing the filter is proved by selecting the entry's text and
        // deleting it: the filter is gone because the text that caused it is
        // gone. A `type_text` with an empty string is a no-op (measured), so it
        // looks like a clear and is not one.
        const cleared = await runSteps(driver, {
          target,
          steps: [
            { tool: "hotkey", args: { keys: ["ctrl", "f"] } },
            { tool: "hotkey", args: { keys: ["ctrl", "a"] } },
            { tool: "press_key", args: { key: "BackSpace" } },
          ],
          observe: { screenshot: false },
          foregroundFallback: true,
        });
        expect(cleared.ok, `could not clear the filter: ${cleared.failure ?? ""}`).toBe(true);
        const restored = await waitForLabels(driver, target, ["proof-beta.txt", "proof-gamma.txt"]);
        const labelsRestored = restored.elements.map((element) => element.label ?? "").join(" ");
        // Clearing the filter is the observable change: the files that were
        // hidden must be listed again.
        expect(labelsRestored, "clearing the filter must list the files again").toContain("proof-beta.txt");
        expect(labelsRestored).toContain("proof-gamma.txt");

        /* ── a desktop fill: the route a Vault needs on a native app ── */

        // A GTK dialog with a masked entry, because that is the case the page
        // route cannot cover: the secret goes into a native widget, not a DOM
        // input. `python3-gi` ships on the template, so this needs no install.
        await provider.putFile(
          box,
          "/tmp/vault.py",
          [
            "import gi",
            'gi.require_version("Gtk", "3.0")',
            "from gi.repository import Gtk",
            "w = Gtk.Window(title='Terabot Vault Fill')",
            "w.set_default_size(360, 130)",
            "box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=12)",
            "box.pack_start(Gtk.Label(label='API key'), False, False, 0)",
            "e = Gtk.Entry()",
            "e.set_visibility(False)",
            "e.set_name('secret')",
            "e.set_placeholder_text('API key')",
            "box.pack_start(e, False, False, 0)",
            "def on_save(_button):",
            "    open('/tmp/seen.txt', 'w').write(e.get_text())",
            "button = Gtk.Button(label='Save')",
            "button.connect('clicked', on_save)",
            "box.pack_start(button, False, False, 0)",
            "w.add(box)",
            "w.connect('destroy', Gtk.main_quit)",
            "w.show_all()",
            "Gtk.main()",
          ].join("\n"),
        );
        await provider.exec(box, "setsid python3 /tmp/vault.py >/tmp/vault.log 2>&1 < /dev/null & sleep 1; true", {
          timeoutSeconds: 30,
        });

        const dialogWindow = await waitForWindow(driver, /terabot vault fill/i);
        expect(dialogWindow, "the GTK dialog must have opened").toBeDefined();
        const dialogTarget: WindowTarget = { pid: dialogWindow!.pid, windowId: dialogWindow!.windowId };
        const dialog = await observeWindow(driver, dialogTarget);
        const secretField = dialog.elements.find((element) => /password/i.test(element.role));
        // A real toolkit exposes the widget as a masked text field; that is the
        // whole reason this route exists rather than typing at a coordinate.
        expect(secretField, "the dialog must expose a password field").toBeDefined();
        console.log(`  desktop field: role=${secretField!.role} token=${secretField!.token}`);

        const desktopValue = `desktop-${Date.now()}`;
        const desktopFill = await time("fillSecret (desktop)", () =>
          fillSecret(driver, {
            target: dialogTarget,
            fill: {
              kind: "element",
              observation: dialog,
              elementToken: secretField!.token,
              expect: { role: "password text" },
            },
            value: desktopValue,
          }),
        );
        expect(desktopFill.effect, `desktop fill failed: ${desktopFill.message}`).not.toBe("refused");
        // MEASURED: a GTK masked entry reports **no value at all** through
        // AT-SPI, so neither `set_value`'s verdict nor a read-back can say the fill
        // worked. What proves it is the application's own view of the field, which
        // this dialog writes to a file when Save is pressed.
        expect(desktopFill.landed, `an unreadable field must not claim it landed: ${desktopFill.message}`).not.toBe(true);
        // The value itself must never appear anywhere in the result.
        expect(JSON.stringify(desktopFill)).not.toContain(desktopValue);
        // Press the dialog's own Save, then read what the application thinks its
        // field holds. This is the only evidence that exists for a masked native
        // widget: the toolkit reports nothing, so the app has to say.
        const saveButton = (await observeWindow(driver, dialogTarget)).elements.find(
          (element) => element.role === "button",
        );
        expect(saveButton, "the dialog must expose its Save button").toBeDefined();
        await click(driver, dialogTarget, { elementToken: saveButton!.token }, { delivery: "foreground" });
        const saved = await waitForFile(provider, box, "/tmp/seen.txt", 8000);
        expect(saved, "the dialog must have received the value it was filled with").toBe(desktopValue);
        const dialogAfter = await observeWindow(driver, dialogTarget);
        const fieldAfter = dialogAfter.elements.find((element) => /password/i.test(element.role));
        // Whatever the toolkit reports, it must never be the value itself.
        if (fieldAfter?.value !== undefined && fieldAfter.value !== null) {
          expect(String(fieldAfter.value)).not.toContain(desktopValue);
        }
        console.log(`  dialog received the value; toolkit reports: ${JSON.stringify(fieldAfter?.value)}`);

        /* ── a fill with a value this code chose, into a target it can name ── */

        // A real login form on the box itself, so the fill has a password field:
        // the case a Vault fill exists for. Host-executed, box-applied, and the
        // target must be a ref this call can see.
        await provider.putFile(
          box,
          "/tmp/login/index.html",
          [
            "<!doctype html><html><head><title>Sign in</title></head><body>",
            '<h1>Sign in</h1><form onsubmit="event.preventDefault()">',
            '<label for="e">Email</label><input id="e" name="email" type="text">',
            '<label for="p">Password</label><input id="p" name="password" type="password">',
            '<button type="submit">Sign in</button></form></body></html>',
          ].join(""),
        );
        await provider.exec(
          box,
          "cd /tmp/login && setsid python3 -m http.server 8099 >/tmp/http.log 2>&1 < /dev/null & sleep 1; true",
          { timeoutSeconds: 30 },
        );

        const profileName = `live-${Date.now()}`;
        const prepared = await time("prepareBrowser", () =>
          prepareBrowser(driver, { profile: { mode: "isolated_named", name: profileName } }),
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
          browserNavigate(driver, { targetId: tab.targetId, tabId: tab.tabId, url: "http://127.0.0.1:8099/" }),
        );

        const page = await time("readPage", () =>
          readPage(driver, { targetId: tab.targetId, tabId: tab.tabId }),
        );
        expect(page.title).toBe("Sign in");
        // Text that only a rendered page has: it exists because the browser parsed
        // the document, not in any HTTP body we could have read ourselves.
        expect(page.outline.length).toBeGreaterThan(10);
        // Detection rides on the same read and costs nothing extra.
        expect(page.captcha.gated).toBe(false);

        const passwordRef = page.refs.find(
          (ref) => ref.actions.includes("type") && /password/i.test(`${ref.name ?? ""} ${ref.role}`),
        );
        expect(passwordRef, "the login form must expose a password field").toBeDefined();

        const secret = "correct-horse-battery-staple";
        const filled = await time("fillSecret (page)", () =>
          fillSecret(driver, {
            target: { pid: prepared.pid!, windowId: browserWindows[0]!.windowId },
            fill: { kind: "page", targetId: tab.targetId, tabId: tab.tabId, ref: passwordRef!.ref },
            value: secret,
          }),
        );
        // The proof: a read-back shows the field holding the value. A password
        // reports a mask, so `landed` is the honest answer and `verified` stays
        // the driver's own verdict.
        expect(filled.landed, `fill did not land: ${filled.message}`).toBe(true);
        expect(filled.message).toBe("The field now holds the value.");
        expect(JSON.stringify(filled), "the secret must never be in the result").not.toContain(secret);

        const afterFill = await readPage(driver, tab);
        const passwordAfter = afterFill.refs.find((ref) => /password/i.test(`${ref.name ?? ""}`)) ?? afterFill.refs[0];
        console.log(`  password field reads back as: ${JSON.stringify(passwordAfter?.value)}`);
        expect(passwordAfter?.value, "the field must be filled, masked or not").toBeTruthy();

        /* ── a second read of the same page is a different snapshot ── */

        expect(afterFill.snapshotId).not.toBe(page.snapshotId);

        const image = await time("screenshot", () => screenshot(driver, target));
        expect(image.data.length).toBeGreaterThan(1000);
        expect(image.mime).toContain("image");

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
 * Observe a window until it shows all the labels a test needs.
 *
 * A file manager enumerating a folder is asynchronous: the first read after
 * launch can arrive before the listing does (measured — the window exists, the
 * files do not yet). Polling for a *named* label is the honest fix: it waits for
 * the app's own state rather than sleeping a guessed interval.
 */
async function waitForLabels(
  driver: CuaDriver,
  target: WindowTarget,
  labels: string[],
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = await observeWindow(driver, target);
  while (Date.now() < deadline) {
    const text = last.elements.map((element) => element.label ?? "").join(" ");
    if (labels.every((label) => text.includes(label))) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await observeWindow(driver, target);
  }
  return last;
}

/** Wait for a file on the box to hold something, and hand back its contents. */
async function waitForFile(
  provider: InstaboxProvider,
  box: { id: string },
  path: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = await provider.exec(box, `cat ${path} 2>/dev/null || true`, { timeoutSeconds: 15 });
    const text = read.stdout.trim();
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "";
}

/** Wait for a window whose title matches, then hand back the one that did. */
async function waitForWindow(driver: CuaDriver, title: RegExp, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = (await listWindows(driver)).find((entry) => title.test(entry.title ?? ""));
    if (window) return window;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

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
