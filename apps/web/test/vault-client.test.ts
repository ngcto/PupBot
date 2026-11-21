import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A client component that imports the vault's main entry point drags `pg` into the
 * browser bundle, and the page fails at runtime with "Module not found: Can't
 * resolve 'dns'" — which is how this was found the first time, in a browser,
 * instead of in a check. The vault's kinds module is pure data and is the only part
 * a client may touch.
 *
 * This walks the components and fails on any import of the whole package.
 */

const COMPONENTS = join(import.meta.dirname, "..", "components");

function clientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...clientFiles(path));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("client components and the vault", () => {
  it("never import the vault's server entry point", () => {
    const offenders: string[] = [];

    for (const path of clientFiles(COMPONENTS)) {
      const source = readFileSync(path, "utf8");
      if (!source.startsWith('"use client"') && !source.startsWith("'use client'")) continue;
      // The bare package specifier is the problem; `@terabot/vault/kinds` is fine.
      if (/from\s+["']@terabot\/vault["']/.test(source)) {
        offenders.push(relative(COMPONENTS, path));
      }
    }

    expect(offenders, "client components must import @terabot/vault/kinds, not @terabot/vault").toEqual([]);
  });

  it("keeps the grouped-input helper free of any server import", () => {
    const kinds = readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "vault", "src", "kinds.ts"), "utf8");
    // The whole reason the module can be imported by a browser component.
    expect(kinds).not.toMatch(/from\s+["']@terabot\/db/);
    expect(kinds).not.toMatch(/from\s+n(crypto|ode:)/);
  });
});
