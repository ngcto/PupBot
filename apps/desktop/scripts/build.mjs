import { access, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = resolve(appDir, "dist");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Main process: ESM, one bundle. electron-updater stays external so it ships as
// a real dependency instead of being inlined into the entry.
await build({
  entry: { main: resolve(appDir, "src/main/index.ts") },
  outDir,
  format: ["esm"],
  platform: "node",
  target: "node22",
  external: ["electron", "electron-updater"],
  sourcemap: true,
  silent: true,
});

// Preload: CommonJS, because a sandboxed preload may not be an ES module, and
// bundled so the shared IPC contract is inlined rather than required at runtime.
await build({
  entry: { preload: resolve(appDir, "src/preload/index.ts") },
  outDir,
  format: ["cjs"],
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  silent: true,
  outExtension: () => ({ js: ".cjs" }),
});

// Fail the build if the two files Electron needs are not where main.js expects
// them, instead of discovering it at launch.
for (const file of ["main.js", "preload.cjs"]) {
  await access(resolve(outDir, file));
}

console.log("built dist/main.js and dist/preload.cjs");
