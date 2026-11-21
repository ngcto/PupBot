import { describe, expect, it } from "vitest";
import { InstaboxProvider } from "@terabot/computers";
import {
  CuaDriver,
  browserNavigate,
  browserState,
  cuaFillSinkFor,
  execTargetFor,
  listWindows,
  prepareBrowser,
  readPage,
} from "../src/index.ts";

/**
 * The NGS-80 acceptance proof against a **real box**, with the **real sink**.
 *
 * The criterion the issue closes on, run as one action: **a value out of a vault item
 * lands in a real page on a real machine, and the page's own read-back says so.** What
 * this adds over `live.test.ts` is not the filling — that route is already proven with a
 * literal string — but that the value comes from `VaultService`, through
 * `createCuaFillSink`, and that the field it lands in is the one the vault chose for the
 * host.
 *
 * Opt in with `CUA_LIVE=1` and `INSTABOX_API_KEY`. It provisions one box, installs the
 * driver, serves a login form, fills it from a vault item, and destroys the box.
 *
 * **The routes, stated separately because only one is evidence here:**
 *
 * - **Page route (this test).** The driver reads the field back, so a fill can be
 *   *evidenced* rather than inferred. This is the route that runs.
 * - **Desktop route (not this test).** A GTK masked entry reports no value at all
 *   through AT-SPI — measured twice, in TERA-74's handoff — so a desktop password fill
 *   has no read-back oracle. Its only evidence is the application's own view, which is
 *   a different proof and belongs to that thread's harness.
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

/**
 * The value this proof uses. A fake, in the same `fake-` shape the rest of the suite
 * uses, so a leaked string in a log is obviously a test artefact and never a credential.
 */
const SECRET = "fake-vault-live-9fq2-not-a-real-password";

describe.skipIf(!live)("NGS-80 live: a vault item filled into a real page", () => {
  it(
    "fills the password field from a stored item, and the page reports it landed",
    async () => {
      const provider = new InstaboxProvider({ account: "instabox:ngs80-live", apiKey });
      const box = await provider.provision({ ttlSeconds: 3600, metadata: { "terabot-test": "ngs80-live" } });

      try {
        // Desktop first, then the driver, then `ensureReady` — which is what actually
        // starts the daemon. Installing the driver alone leaves the socket absent and
        // every call fails with "daemon is not reachable".
        await ensureDesktop(provider, box);
        const version = await provider.exec(box, INSTALL, { timeoutSeconds: 600 });
        expect(version.exitCode).toBe(0);

        await provider.putFile(
          box,
          "/tmp/login/index.html",
          [
            "<!doctype html><html><head><title>Sign in</title></head><body>",
            "<h1>Sign in</h1><form onsubmit=\"event.preventDefault()\">",
            '<label for="p">Password</label><input id="p" name="password" type="password">',
            '<button type="submit">Sign in</button></form></body></html>',
          ].join(""),
        );
        await provider.exec(
          box,
          "cd /tmp/login && setsid python3 -m http.server 8099 >/tmp/http.log 2>&1 < /dev/null & sleep 1; true",
          { timeoutSeconds: 30 },
        );

        // One session for the whole proof: the driver keys its ref cache by session, so
        // a sink in a different one would find none of these refs and refuse.
        const session = "ngs80";
        const driver = new CuaDriver(execTargetFor(provider, box), { session });
        const ready = await driver.ensureReady();
        expect(ready.ok, `the driver must be ready: ${JSON.stringify(ready)}`).toBe(true);
        expect(ready.accessibility).toBe(true);
        const prepared = await prepareBrowser(driver, {
          profile: { mode: "isolated_named", name: `ngs80-${Date.now()}` },
        });
        expect(prepared.prepared).toBe(true);
        const windows = await listWindows(driver, { pid: prepared.pid });
        expect(windows.length).toBeGreaterThan(0);
        const bound = await browserState(driver, { window: { pid: prepared.pid!, windowId: windows[0]!.windowId } });
        expect("targetId" in bound && bound.bindingQuality).toBe("exact");
        const tab = bound as { targetId: string; tabId: string };

        await browserNavigate(driver, { targetId: tab.targetId, tabId: tab.tabId, url: "http://127.0.0.1:8099/" });
        const page = await readPage(driver, tab);
        expect(page.title).toBe("Sign in");

        // Before anything is typed, the field must read as empty. Without this the
        // mask count below proves nothing: a read-back that reported masks for any
        // field would look identical to a landed value.
        const beforeAnyFill = page.refs.find((entry) => /password/i.test(`${entry.name ?? ""}`));
        expect(String(beforeAnyFill?.value ?? "")).toBe("");

        const passwordRef = page.refs.find(
          (entry) => entry.actions.includes("type") && /password/i.test(`${entry.name ?? ""} ${entry.role}`),
        );
        expect(passwordRef, "the form must expose a password field").toBeDefined();

        /**
         * The fill, through the real sink. `surface` names the tab because this caller
         * is the one that knows which page the user is on; nothing below re-aims.
         */
        const sink = cuaFillSinkFor({
          provider,
          ref: box,
          session,
          surface: { kind: "page", targetId: tab.targetId, tabId: tab.tabId },
        });

        const outcome = await sink.fill({
          url: "http://127.0.0.1:8099/",
          // The ref and the snapshot both come from the page read that saw the field:
          // `snapshotId` is the page observation's own id, not the tab's target id, and
          // a token from a different snapshot is refused by name rather than re-aimed.
          target: { token: passwordRef!.ref, snapshotId: page.snapshotId },
          field: "password",
          value: SECRET,
        });

        console.log(
          `  fill reported effect=${outcome.effect} verified=${outcome.verified} refusal=${outcome.refusalCode ?? "none"} evidence=${outcome.evidence ?? "none"}`,
        );
        console.log(`  ref used: ${passwordRef!.ref}  page snapshot: ${page.snapshotId}`);
        // The Captain's bar: `unverifiable` proves nothing about a value landing, so a
        // proof that passes on it is not a proof.
        // MEASURED on a real box: the fill lands and the page's read-back confirms it
        // (`landed: true`, surfaced as the evidence below), but the driver reports
        // `unverifiable` for the write — it only classifies a payload it recognises, and
        // guessing `confirmed` for a write it does not would claim a field holds a value
        // on evidence that does not support it. So the honest bar here is the read-back,
        // not the effect label, and this asserts the read-back.
        expect(outcome.effect, `unexpected effect: ${outcome.effect}`).toBe("unverifiable");
        expect(outcome.evidence ?? "", "the read-back must name the field as holding the value").toContain(
          "holds the value",
        );
        expect(outcome.verified, "the driver's own verdict is false for a write it cannot classify").toBe(false);
        // The value must never be in what the sink returns — that object becomes a tool
        // result, which is model context by definition.
        expect(JSON.stringify(outcome)).not.toContain(SECRET);

        const after = await readPage(driver, tab);
        const passwordAfter = after.refs.find((entry) => /password/i.test(`${entry.name ?? ""}`));
        console.log(`  the page reports its password field as: ${JSON.stringify(passwordAfter?.value)}`);
        // A page password input reports a mask rather than the value, so this asserts
        // the field is no longer empty and that the value was never echoed.
        if (passwordAfter?.value !== null && passwordAfter?.value !== undefined) {
          expect(String(passwordAfter.value)).not.toContain(SECRET);
        }
        expect(String(passwordAfter?.value ?? "")).not.toBe("");

        /**
         * The negative control, on the same box and the same field.
         *
         * A read-back that reported masks regardless of what was typed would make the
         * assertion above worthless. So the same sink fills a value of a *different
         * length*, and the page must report that length instead: if the count were a
         * property of the field rather than the value, it would still say forty.
         */
        const CONTROL = "fake-short-11";
        expect(CONTROL.length).toBe(13);
        const controlPage = await readPage(driver, tab);
        const controlRef = controlPage.refs.find(
          (entry) => entry.actions.includes("type") && /password/i.test(`${entry.name ?? ""} ${entry.role}`),
        );
        expect(controlRef, "the field must still be there for the control").toBeDefined();
        const control = await sink.fill({
          url: "http://127.0.0.1:8099/",
          target: { token: controlRef!.ref, snapshotId: controlPage.snapshotId },
          field: "password",
          value: CONTROL,
        });
        const afterControl = await readPage(driver, tab);
        const controlValue = String(
          afterControl.refs.find((entry) => /password/i.test(`${entry.name ?? ""}`))?.value ?? "",
        );
        console.log(`  control fill effect=${control.effect}; the page now reports ${controlValue.length} masks`);
        // The count follows the value: this is what makes the forty above evidence.
        expect(controlValue.length).toBe(CONTROL.length);
        expect(controlValue.length).not.toBe(SECRET.length);
        expect(controlValue).not.toContain(CONTROL);
      } finally {
        await provider.destroy(box).catch(() => undefined);
      }
    },
    900_000,
  );
});

/**
 * Brings the box's desktop and the driver's daemon up.
 *
 * Copied from `live.test.ts` rather than shared, because the provider's desktop
 * endpoint is reached through a client the provider does not export and a shared
 * helper would mean widening that surface for one test. Retried because a fresh box
 * installs XFCE on first call and takes most of a minute.
 */
async function ensureDesktop(provider: InstaboxProvider, box: { id: string }): Promise<void> {
  const client = (
    provider as unknown as {
      client: {
        desktop: (id: string, body: object, options?: object) => Promise<{ installed: boolean; running: boolean }>;
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
