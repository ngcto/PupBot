# TERA-81 — the code-mode table, re-measured

**This document replaces the code-mode table in `reports/tera-81-bench.md`, which is void.** All three
code-mode arms in that document were measured with `codemode` wrapped inside `codemode`, so the model
received a shell whose index listed one tool. See `reports/ngs-85-refusals.md` for that defect and its
fix.

**Model: `claude-haiku-5-5`, every arm, every run, one sitting.** The earlier `claude-sonnet-5-5`
anchor is **retired, not superseded** — its measurements were void, so there is nothing here to
compare against. Do not read a difference between a number in this document and a number in the old
one as a change in the surface. Two things changed at once: the wrapper was fixed, and the model
changed because the endpoint's allowance could no longer serve a 26-tool request on sonnet.

## Method

- Eleven tasks, three code-mode arms plus arm B, three reps per cell, 132 runs, every one through the
  real `executeRun`. Arms differ only in the `tools` array.
- The desktop and browser tools are **fixtures** of the same 26 capabilities, not a real driver.
  `packages/cua` is still open (#38). Nothing here is a claim about CUA.
- Turns means model round trips, not tool calls.
- All 132 rows are real runs. Two reps answered `403` mid-run and were re-attempted; the dataset
  committed here contains no `403` row.

## The table

| Arm | Cells | Turns | Prompt tokens (all, billed) | of which uncached | of which cached | Out tokens | Wall (model ms) |
|---|---|---|---|---|---|---|---|
| B — 26 native schemas | **7/11** | 30 | 213,461 | 82 | 213,344 | 6,279 | 90,337 |
| C — code mode, inline index | **6/11** | **26** | **148,830** | 74 | 148,753 | 5,640 | 72,559 |
| D — code mode, lazy (146 tok) | 6/11 | 36 | 185,762 | 94 | 184,302 | 7,860 | 108,811 |
| E — code mode, names (227 tok) | 5/11 | **23** | **107,755** | 68 | 107,859 | 6,447 | 69,200 |

Per-cell, so variance is visible:

| Task | B | C | D | E |
|---|---|---|---|---|
| 1 list and name the apps | 3/3 | 3/3 | 1/3 | 3/3 |
| 2 launch an app | 3/3 | 3/3 | 3/3 | 0/3 |
| 3 fill two fields | 0/3 | 0/3 | 0/3 | 0/3 |
| 4 act and verify without an image | 3/3 | 2/3 | 1/3 | 0/3 |
| 5 multi-step sequence | 0/3 | 0/3 | 0/3 | 2/3 |
| 6 the tree is degraded | 3/3 | 0/3 | 3/3 | 2/3 |
| 7 a gated page | 3/3 | 3/3 | 3/3 | 0/3 |
| 8 act and confirm the value landed | 2/3 | 2/3 | 3/3 | 1/3 |
| 9 recover from a refusal | 1/3 | 1/3 | 0/3 | 1/3 |
| 10 filter a large tree | 0/3 | 0/3 | 2/3 | 2/3 |
| 11 answer without tools | 3/3 | 3/3 | 3/3 | 3/3 |

## What it says

**Code mode is cheaper in tokens — 30% cheaper — and the earlier conclusion was backwards.** Arm C
spent 148,830 prompt tokens against arm B's 213,461, and used fewer turns (26 against 30). The
"more expensive in tokens" finding from the voided table was an artefact of the wrapper: an arm that
could not call a tool spent its turns being told so, then answering.

**The cheap-index variants do not fail the way the voided table said.** D and E were reported as the
two worst arms, at 1/11 each. Measured properly: **D 6/11, E 5/11.** E is the cheapest in prompt
tokens and turns of any arm, and it still passes 5 cells. Neither collapses. The disclosure curve is
real but gentle, and it is not a cliff.

**The token saving is not the raw saving it looks like.** 99.96% of every arm's prompt tokens are
**cache reads** — the endpoint caches the prompt, and `input_tokens` reports only the uncached
remainder, which is why the old column read `in=6`. The correct column is the total. It also means
these numbers are only meaningful with the cache behaving this way: turn off prompt caching and the
same surfaces cost very different amounts, with arm B's repeated 26-schema block hit hardest.

**Arm B wins on correctness by one cell and it is not a strong win.** 7/11 against 6/11, and the
per-cell table shows they split: B takes task 6, C is a rep weaker on 4 and 8. On a different model
this could go either way, and one cell is inside the noise of three reps.

**Four tasks are 0/3 or near it in every arm** — 3, 5, 9, 10. Those are the tasks nobody can do,
not the surface's fault, and they deserve their own look before the next comparison.

## The three defects this measurement took

Each was caught by a number that was impossible on its face, and none was in the surface being
compared — which is worth stating, because it means the arms were being measured through a broken
instrument three times while the instrument appeared to work.

1. **The double wrap** (`ngs-85-refusals.md`). The arms were never code mode.
2. **A usage event emitted for an empty `message_start`.** The endpoint sends
   `input_tokens: 0, output_tokens: 0` there and the real count on `message_delta`; the adapter
   emitted usage for both, and the bench sums, so a turn recorded zero beside its real count.
3. **The bench counted only `input_tokens` — that is, cache *misses*** — and discarded `cacheRead`
   and `cacheWrite`. This is the one that mattered: the two arms cache very differently, so the
   column compared B's cache misses against C's and called it their cost. Before the fix, this
   table read arm B at 7/11 and 80 prompt tokens against arm C's 6/11 and 70 — a comparison of
   nothing.

## What this does not tell you

- Not a CUA claim: fixtures, not a real driver.
- Not a sonnet claim: one model, and a weaker one than the voided run.
- Not a caching claim: every prompt token here is a cache read, and that is a property of this
  endpoint on these requests, not of the product.
- Not a shipping recommendation. Four arms, eleven fixture tasks, one model.

## Reproducing it

```
BENCH_MODEL=claude-haiku-5-5 pnpm --filter @terabot/agent bench --arm=bcde --tasks=all --reps=3
```

Writes `reports/tera-81-bench/bcde-claude-haiku-5-5-3rep.json`.
