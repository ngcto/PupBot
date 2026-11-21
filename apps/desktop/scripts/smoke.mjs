#!/usr/bin/env node
/**
 * End-to-end smoke for the shell. It launches the built Electron app against a
 * product that is already running, then proves from the outside that:
 *
 *   - exactly one window is created and the hosted page loads on the product origin
 *   - Node is not reachable from the page, and the preload bridge is
 *   - foreign navigations and popups are refused, same-origin popups stay in-shell
 *   - a `terabot://` link on a cold start and from a second launch reaches the product
 *   - signing in works, and survives a restart when `--restart` is set
 *
 * It saves a screenshot, which is the evidence a person can look at.
 *
 * On a headless Linux box run it under a virtual display:
 *   xvfb-run -a node scripts/smoke.mjs --url http://localhost:3000 \
 *     --sign-in demo@pupbot.dev:pupbot-demo --out .smoke/shell.png
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const targetUrl = option("url", process.env.TERABOT_APP_URL ?? "http://localhost:3000");
const outputPath = resolve(appDir, option("out", ".smoke/shell.png"));
const credentials = option("sign-in", process.env.TERABOT_SMOKE_SIGN_IN ?? "");
const coldDeepLink = option("deep-link", "");
const secondDeepLink = option("second-instance", "");
const restart = process.argv.includes("--restart");
const targetOrigin = new URL(targetUrl).origin;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

/** The rule from src/shared/deeplink.ts, restated so the harness can assert it. */
function expectedDeepLinkTarget(link) {
  const parsed = new URL(link);
  const app = new URL(targetUrl);
  const basePath = app.pathname.replace(/\/+$/, "");
  return `${app.origin}${basePath}/${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function launchShell(userDataDir, extraArgs = []) {
  return electron.launch({
    executablePath: electronPath,
    cwd: appDir,
    args: [
      // Chromium's setuid sandbox is not installed in CI containers; this flag
      // affects the smoke run only, packaged builds keep the real sandbox.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userDataDir}`,
      appDir,
      ...extraArgs,
    ],
    env: { ...process.env, TERABOT_APP_URL: targetUrl },
    timeout: 30_000,
  });
}

async function launchSecondInstance(link, userDataDir) {
  const child = spawn(
    electronPath,
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userDataDir}`,
      appDir,
      link,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code ?? -1)));
  const hanging = new Promise((resolveHang) => setTimeout(() => resolveHang("still running"), 15_000));
  return Promise.race([exited, hanging]);
}

function splitCredentials(value) {
  const separator = value.indexOf(":");
  if (separator === -1) throw new Error("--sign-in wants email:password");
  return { email: value.slice(0, separator), password: value.slice(separator + 1) };
}

async function signIn(page) {
  const { email, password } = splitCredentials(credentials);
  await page.goto(targetUrl);
  if (page.url().includes("/sign-in")) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  await page.waitForSelector('[data-testid="send"], [data-testid="bot-chip"]', { timeout: 30_000 });
}

async function run(launched, userDataDir) {
  const pageErrors = [];
  const page = await launched.firstWindow({ timeout: 30_000 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);

  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.body !== null && document.body.innerText.trim().length > 0);

  record("one window", launched.windows().length === 1, `saw ${launched.windows().length}`);
  record("product origin", new URL(page.url()).origin === targetOrigin, page.url());

  const title = await page.title();
  record("page loaded with a title", title.trim().length > 0, title);

  const bodyText = await page.evaluate(() => document.body.innerText.trim().length);
  record("product rendered text", bodyText > 0, `${bodyText} characters`);

  const security = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    ipc: typeof window.ipcRenderer,
    bridge: typeof window.terabotDesktop?.getInfo,
  }));
  record(
    "node is not exposed to the page",
    security.require === "undefined" && security.process === "undefined" && security.ipc === "undefined",
    JSON.stringify(security),
  );
  record("preload bridge is exposed", security.bridge === "function", JSON.stringify(security));

  await page.addInitScript(() => {
    window.__terabotDeepLinks = [];
    window.terabotDesktop?.onDeepLink((url) => window.__terabotDeepLinks.push(url));
  });

  if (coldDeepLink) {
    const expected = expectedDeepLinkTarget(coldDeepLink);
    await page.waitForURL((url) => url.href === expected, { timeout: 20_000 });
    record("deep link opened the product route on start", page.url() === expected, page.url());
  }

  const info = await page.evaluate(() => window.terabotDesktop.getInfo());
  record("bridge reports the shell version", typeof info?.appVersion === "string" && info.appVersion.length > 0, JSON.stringify(info));
  record("bridge reports the product URL", info?.appUrl === new URL(targetUrl).toString(), JSON.stringify(info));

  // A foreign popup is refused (data: keeps the system browser out of it).
  const windowsBeforePopup = launched.windows().length;
  await page.evaluate(() => void window.open("data:text/html,blocked", "_blank"));
  await page.waitForTimeout(500);
  record("foreign popup refused", launched.windows().length === windowsBeforePopup, `saw ${launched.windows().length}`);

  // A foreign top-level navigation is refused and the product stays put.
  const urlBefore = page.url();
  await page
    .evaluate(() => {
      window.location.href = "data:text/html,blocked";
    })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  record("foreign navigation refused", page.url() === urlBefore, page.url());

  // A same-origin popup is allowed and runs in the same shell.
  const popupPromise = page.waitForEvent("popup", { timeout: 10_000 });
  await page.evaluate(() => void window.open("/sign-in", "_blank"));
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  record("same-origin popup stays in the shell", new URL(popup.url()).origin === targetOrigin, popup.url());
  await popup.close();

  let secondInstance = "skipped";
  if (secondDeepLink) {
    const expected = expectedDeepLinkTarget(secondDeepLink);
    const code = await launchSecondInstance(secondDeepLink, userDataDir);
    record("a second launch exits instead of opening a second shell", code === 0, `exit ${code}`);

    await page.waitForURL((url) => url.href === expected, { timeout: 20_000 });
    record("second launch forwarded its deep link to the running window", page.url() === expected, page.url());

    const delivered = await page.evaluate(() => window.__terabotDeepLinks ?? []);
    record("the product received the deep link event", delivered.includes(expected), JSON.stringify(delivered));
    secondInstance = page.url();
  }

  if (credentials) {
    await signIn(page);
    record("signed in inside the shell", true, page.url());
  }

  if (coldDeepLink || secondDeepLink) await page.goto(targetUrl);

  // Let fonts, avatars and the first paint settle before the screenshot.
  await page.waitForTimeout(1_500);
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath });
  const bytes = (await stat(outputPath)).size;

  return {
    window: { title, url: page.url(), signedIn: credentials !== "", secondInstance },
    shell: info,
    checks,
    pageErrors,
    screenshot: { path: outputPath, bytes },
  };
}

async function main() {
  const probe = await fetch(targetUrl, { redirect: "manual" }).catch(() => undefined);
  if (!probe) throw new Error(`nothing answered at ${targetUrl}; start the product first`);

  const userDataDir = await mkdtemp(join(tmpdir(), "terabot-smoke-"));
  const launched = await launchShell(userDataDir, coldDeepLink ? [coldDeepLink] : []);

  let summary;
  try {
    summary = await run(launched, userDataDir);
  } finally {
    await launched.close();
  }

  let restartUrl = "skipped";
  if (restart && credentials) {
    const relaunched = await launchShell(userDataDir);
    try {
      const page = await relaunched.firstWindow({ timeout: 30_000 });
      await page.waitForLoadState("domcontentloaded");
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
      restartUrl = page.url();
      record("the session survived a restart", new URL(restartUrl).origin === targetOrigin, restartUrl);
      summary.checks = checks;
    } finally {
      await relaunched.close();
    }
  }

  return { ok: true, ...summary, restart: restartUrl, userDataDir };
}

function withTimeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`smoke run timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

withTimeout(main(), 180_000).then(
  (result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  },
  (error) => {
    console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
