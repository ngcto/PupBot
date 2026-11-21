/**
 * Renders the 1200x630 share cards into public/og.
 *
 * Run after a build so the Inter subset next/font fetched is on disk:
 *   pnpm --filter @pupbot/marketing build
 *   node apps/marketing/scripts/make-og.mjs
 * The cards are checked in, so this only runs when the copy or the brand moves.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const out = join(app, "public", "og");

function interFont() {
  const media = join(app, ".next", "static", "media");
  try {
    const files = readdirSync(media).filter((name) => name.endsWith(".woff2"));
    if (!files.length) return "";
    const largest = files
      .map((name) => ({ name, size: readFileSync(join(media, name)).length }))
      .sort((a, b) => b.size - a.size)[0];
    const base64 = readFileSync(join(media, largest.name)).toString("base64");
    return `@font-face{font-family:"InterCard";font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${base64}) format("woff2");}`;
  } catch {
    return "";
  }
}

const cards = {
  home: {
    headline: "Bots that each get<br/>their own computer.",
    line: "A chat app for bots you set up yourself. Your model, your key, its own cloud machine.",
    shot: "shots/app-shell.png",
  },
  pricing: {
    headline: "Free while it is<br/>in development.",
    line: "One plan today. You bring your own model key and your provider bills you.",
    shot: null,
  },
  download: {
    headline: "Download<br/>Terabot.",
    line: "Desktop for macOS, Windows and Linux. Mobile for iOS and Android. No build is published yet.",
    shot: null,
  },
  docs: {
    headline: "What a bot is,<br/>and how to set one up.",
    line: "Conversation, instructions and a cloud computer of its own.",
    shot: null,
  },
};

const font = interFont();

function html({ headline, line, shot }) {
  const image = shot ? readFileSync(join(app, "public", shot)).toString("base64") : null;
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    ${font}
    *{box-sizing:border-box;margin:0}
    body{width:1200px;height:630px;background:#121212;color:#f5f5f5;
      font-family:${font ? '"InterCard",' : ""}system-ui,sans-serif;overflow:hidden;position:relative}
    .glow{position:absolute;left:0;right:0;top:-260px;height:700px;
      background:radial-gradient(60% 60% at 40% 0%,rgba(245,245,245,.09),transparent 70%)}
    .frame{position:absolute;inset:0;border:1px solid #1e1e1e}
    .wrap{position:relative;padding:64px 72px;height:100%;display:flex;flex-direction:column}
    .mark{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:600;letter-spacing:-.03em}
    .mark svg{display:block}
    h1{margin-top:auto;font-size:${shot ? "64px" : "70px"};line-height:1.02;letter-spacing:-.038em;font-weight:600}
    p{margin-top:22px;font-size:24px;line-height:1.35;color:#ababab;max-width:${shot ? "620px" : "820px"}}
    .foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;color:#707070;font-size:18px}
    .shot{position:absolute;right:0;bottom:0;width:520px;height:400px;overflow:hidden;
      border-top-left-radius:18px;border:1px solid #2b2b2b;border-right:0;border-bottom:0}
    .shot img{width:1040px;display:block;margin-top:-1px}
    .shot::before{content:"";position:absolute;inset:0;background:linear-gradient(105deg,#121212 0%,rgba(18,18,18,.35) 42%,transparent 62%);z-index:2}
  </style></head><body>
    <div class="glow"></div><div class="frame"></div>
    <div class="wrap">
      <div class="mark">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="22" height="22" rx="8" fill="#f5f5f5"/><rect x="7.4" y="9" width="2.6" height="6" rx="1.3" fill="#121212"/><rect x="14" y="9" width="2.6" height="6" rx="1.3" fill="#121212"/></svg>
        <span>terabot</span>
      </div>
      ${shot ? '<div class="shot"><img src="data:image/png;base64,' + image + '"/></div>' : ""}
      <h1>${headline}</h1>
      <p>${line}</p>
      <div class="foot"><span>terabot</span>${shot ? "" : "<span>Free while in development</span>"}</div>
    </div>
  </body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

for (const [name, card] of Object.entries(cards)) {
  await page.setContent(html(card), { waitUntil: "load" });
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(out, `${name}.png`) });
  process.stdout.write(`wrote og/${name}.png\n`);
}

await browser.close();
