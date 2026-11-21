import { defineConfig } from "vitest/config";

// The suite renders every shape twice and compares the markup, which is CPU-bound
// rather than I/O-bound: it measures at ~600 ms here and ~2.7 s on a 2-core CI
// runner. The default 5 s cap therefore sits close enough that one more concurrent
// package in the same `turbo run test` pushes this file's slowest case over it,
// which reads as a flake but is really a runner with no spinning cores left.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
