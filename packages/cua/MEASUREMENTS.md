# Cua Driver: where the runtime lives, and what that costs

This document exists because a measurement decided an architecture. If the numbers
below change, the decision in `packages/agent`'s sandbox placement should change with
them, so the method and the raw observations are written down here rather than left in
a report.

Measured 2026-11-21 against a live Instabox box (`agent-browser` template: Debian 13,
X11/XFCE, `DISPLAY=:1`), cua-driver 0.55.0, from `packages/cua`'s own code paths.

## The two numbers

| Path | Cost | How it was measured |
|---|---|---|
| **In the box**, next to the daemon | **~10 ms** per driver call | `for i in 1 2 3; do /usr/bin/time -f "%e" cua-driver call get_screen_size --socket …; done` → `0.01 s` every time |
| **From our process**, over exec to the box | **~0.5 s** per call | A 4-call sequence (launch, snapshot, click, type) took ~160 ms of driver time inside the box but ~2 s wall clock end to end through one exec, and `launchApp` alone measured 246–677 ms cold |

The ratio is roughly **50×**, and it is a property of the transport, not of the driver:
one exec pays an HTTP round trip to the box and a process spawn for the CLI.

## Why it matters

A model-written program that calls ten tools costs:

- **0.1 s** if the program runs in the box, next to the daemon;
- **5 s** if the program runs in our process and every call is an exec.

A twenty-call computer-use task is the difference between 0.2 s and 10 s of pure transport
per code execution, before any model latency. That is enough to decide where a
computer-heavy program runs — and it is why `Sandbox` in `packages/agent` has the same
API on both sides of the wire.

## What else the measurement showed, and what it costs

Recorded because each one shapes a caller's behaviour:

| Observation | Number | Consequence |
|---|---|---|
| Element tokens survive separate `cua-driver call` invocations through one daemon | valid across calls | The element rung of the ladder is reachable over a stateless transport. Without this, the whole CLI-over-daemon choice fails and the SDK becomes the answer. |
| One screenshot, base64 | 95,728 bytes → ~31,921 tokens | A single image is nine tool definitions' worth of context. Never inline more than one per step, and never by default. |
| A 75-row accessibility tree | 3,119 tokens as JSON, 1,213 as text lines | The 2.6× is free: `observeWindow` already returns a compact outline, and the harness must not re-JSON it. |
| `run_steps` with `expect` checks | 909–1,556 ms for a two-step batch | One batch round trip replaces N model turns; the checks are what make it safe to skip the intermediate reads. |
| Cold `launch_app` | 246–677 ms, sometimes with `windows: []` | A launch is not a window. `launchApp` waits for one rather than handing back an empty handle. |

## What is *not* claimed

- These are **in-box driver call** timings, not model turns. A model turn dwarfs both.
- The 0.5 s exec figure is against Instabox's exec API from a cloud machine; a different
  deployment's exec could be faster or slower, which is why the ratio — not the absolute
  number — is the load-bearing part.
- No measurement was taken of a program running in the box under load. The 10 ms figure is
  a single call on an idle box.

## Reproducing

```sh
# 1. a box with a desktop
CUA_LIVE=1 pnpm --filter @terabot/cua exec vitest run test/live.test.ts

# 2. the per-call cost
instabox exec <box> -- bash -lc 'export PATH=$HOME/.local/bin:$PATH DISPLAY=:1
  for i in 1 2 3; do /usr/bin/time -f "%e s" cua-driver call get_screen_size --socket /tmp/terabot-cua.sock; done'
```

The live test's `timings` map prints every stage it measures, so a change in any of these
numbers shows up in its output.
