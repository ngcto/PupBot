#!/usr/bin/env node
/**
 * Fail when a workspace package ships source but no `lint` script.
 *
 * `turbo run lint` only runs the `lint` task in packages that declare one, so a
 * package without the script is silently unchecked — not skipped loudly, not
 * warned about, just absent from the run. That is how `@terabot/composio` and
 * `@terabot/storage` carried source through a "17 packages, 17 lint tasks, all
 * green" gate without ever being linted.
 *
 * The hole is structural, not a one-time oversight: the workspace globs are
 * `packages/*` and `apps/*`, so the next package someone creates is invisible by
 * default and the gate stays green. This check makes the missing script a
 * failure with the file to add, so being born unchecked is not possible.
 *
 * A package with no source files is exempt — there is nothing to lint, and
 * requiring a script for an empty package would only teach people to add noise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parseWorkspaceGlobs = () => {
  const file = join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    console.error("pnpm-workspace.yaml is missing; cannot tell what a workspace package is");
    process.exit(1);
  }
  const globs = [];
  let inPackages = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const entry = line.match(/^\s+-\s*(\S+)\s*$/);
      if (!entry) {
        if (/^\S/.test(line) && line.trim() !== "") inPackages = false;
        continue;
      }
      globs.push(entry[1].replace(/^\.\//, "").replace(/\/$/, ""));
    }
  }
  return globs;
};

// Only the `dir/*` shape this repo uses; a glob with a wildcard segment other
// than a trailing `*` would need a real matcher, and then this should say so.
const expandGlob = (glob) => {
  const star = glob.indexOf("*");
  if (star === -1) return existsSync(join(repoRoot, glob)) ? [glob] : [];
  const parent = glob.slice(0, star).replace(/\/$/, "");
  const dir = join(repoRoot, parent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .map((name) => join(parent, name));
};

const hasSource = (dir) => {
  const stack = [join(repoRoot, dir)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
};

const problems = [];
const checked = [];

for (const dir of parseWorkspaceGlobs().flatMap(expandGlob)) {
  const manifestPath = join(repoRoot, dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    problems.push(`${relative(repoRoot, manifestPath)} is not valid JSON: ${error.message}`);
    continue;
  }

  const name = manifest.name ?? relative(repoRoot, dir);
  const lint = manifest.scripts?.lint;
  const source = hasSource(dir);
  checked.push({ name, source, lint: Boolean(lint) });

  if (!source) continue;

  if (!lint) {
    problems.push(
      `${name} (${dir}) ships source but has no "lint" script, so \`turbo run lint\` never checks it. ` +
        `Add "lint": "eslint ." to ${dir}/package.json — every other package already has it.`,
    );
  } else if (!/\beslint\b/.test(lint)) {
    problems.push(
      `${name} (${dir}) has a lint script that does not run eslint: "${lint}". ` +
        `The root eslint.config.js is the one config that covers every package, so point the script at \`eslint .\`.`,
    );
  }
}

if (checked.length === 0) {
  problems.push("found no workspace packages at all; the globs in pnpm-workspace.yaml are wrong");
}

if (problems.length > 0) {
  console.error("Lint does not cover every workspace package:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nA package that is not linted reports green because it never ran, which is worse than a red build.",
  );
  process.exit(1);
}

const linted = checked.filter((entry) => entry.lint).length;
console.log(`${checked.length} workspace packages, ${linted} with a lint script`);
for (const entry of checked) {
  console.log(`  ${entry.name.padEnd(26)} ${entry.source ? (entry.lint ? "linted" : "MISSING") : "no source"}`);
}
