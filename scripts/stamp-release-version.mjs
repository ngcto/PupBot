#!/usr/bin/env node
/**
 * Point the download page at one released version.
 *
 * Called by `.github/workflows/release.yml` after the release is published, with
 * the version resolved from the tag and the asset file names the job actually
 * uploaded:
 *
 *   node scripts/stamp-release-version.mjs 0.1.0 "Terabot-0.1.0.AppImage,Terabot Setup 0.1.0.exe,terabot-0.1.0.apk"
 *
 * It writes `apps/marketing/released.version.json` — the one file `releases.ts`
 * reads — and aligns `apps/desktop`'s package version so electron-builder names
 * artifacts with the released number.
 *
 * The asset list is the point: a release where the Windows job failed must not
 * put a Windows link on the site. Only names passed here become buttons.
 *
 * The alternative — a workflow that commits to `main` — was rejected: a release
 * must not push to a protected branch or race a merge. Committing this small JSON
 * after a release is a normal, reviewable edit, and this script is what makes it
 * one command instead of hand-typed strings.
 *
 * Nothing here touches git. It only edits files in the working tree.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const versionFile = resolve(repoRoot, "apps/marketing/released.version.json");
const desktopManifest = resolve(repoRoot, "apps/desktop/package.json");

const input = process.argv[2]?.trim().replace(/^v/, "");
const assetList = process.argv[3] ?? "";

if (!input) {
  console.error("usage: node scripts/stamp-release-version.mjs <version> [comma-separated asset names]");
  process.exit(1);
}

// Same rule the workflow applies before it builds anything.
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(input)) {
  console.error(`"${input}" is not a semver version`);
  process.exit(1);
}

const assets = assetList
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

// A stamp with no assets is the pre-release state, not a release: the site must
// not advertise a version it cannot download.
await writeFile(
  versionFile,
  `${JSON.stringify({ version: assets.length > 0 ? input : null, assets: assets.length > 0 ? assets : [] }, null, 2)}\n`,
  "utf8",
);

const desktop = JSON.parse(await readFile(desktopManifest, "utf8"));
const previous = desktop.version;
desktop.version = input;
await writeFile(desktopManifest, `${JSON.stringify(desktop, null, 2)}\n`, "utf8");

console.log(`released version: ${previous} -> ${input}`);
console.log(`assets published: ${assets.length === 0 ? "(none — site stays Coming soon)" : assets.join(", ")}`);
console.log(`wrote ${versionFile}`);
console.log(`updated ${desktopManifest}`);
