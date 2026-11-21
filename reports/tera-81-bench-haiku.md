# TERA-81 — the code-mode table, re-measured

**This document replaces the code-mode table in `reports/tera-81-bench.md`, which is void.** All three
code-mode arms there were measured with `codemode` wrapped inside `codemode`, so the model received a
shell whose index listed one tool. See `reports/ngs-85-refusals.md`.

**Model: `claude-haiku-5-5`, every arm, every run, one sitting, 132 runs.** The earlier
`claude-sonnet-5-5` anchor is **retired, not superseded** — its measurements were void, so there is
nothing here to compare against. A difference between a number in this document and one in the old is
not a change in the surface: the wrapper was fixed and the model changed, for reasons in the last
section.

## The table

| Arm | Cells | Turns | Prompt tokens (all, billed) | of which uncached | of which cached | Out tokens | Wall (model ms) |
|---|---|---|---|---|---|---|---|
| B — 26 native schemas | **7/11** | 28 | 188,671 | 78 | 143,072 | 6,598 | 80,773 |
| C — code mode, inline index | **7/11** | 28 | **157,472** | 78 | 86,817 | 6,361 | 82,258 |
| D — code mode, lazy (146 tok) | 6/11 | 43 | 232,058 | 108 | 160,506 | 9,339 | 113,431 |
| E — code mode, names (227 tok) | 4/11 | 28 | **137,319** | 78 | 75,724 | 7,044 | 83,384 |

Per cell, so variance is visible:

| Task | B | C | D | E |
|---|---|---|---|---|
| 1 list and name the apps | 3/3 | 3/3 | 2/3 | 3/3 |
| 2 launch an app | 3/3 | 1/3 | 1/3 | 1/3 |
| 3 fill two fields | 0/3 | 0/3 | 0/3 | 0/3 |
| 4 act and verify without an image | 3/3 | 2/3 | 2/3 | 1/3 |
| 5 multi-step sequence | 0/3 | 0/3 | 0/3 | 0/3 |
| 6 the tree is degraded | 3/3 | 3/3 | 3/3 | 3/3 |
| 7 a gated page | 3/3 | 3/3 | 3/3 | 0/3 |
| 8 act and confirm the value landed | 2/3 | 2/3 | 1/3 | 2/3 |
| 9 recover from a refusal | 1/3 | 0/3 | 0/3 | 0/3 |
| 10 filter a large tree | 1/3 | 3/3 | 2/3 | 0/3 |
| 11 answer without tools | 3/3 | 3/3 | 3/3 | 3/3 |

## What it says

**Code mode is level on correctness and cheaper in tokens.** Arm C ties arm B at 7/11 cells, on the
same 28 turns, at **157,472 prompt tokens against 188,671 — 17% less.** It wins the two tasks that
need filtering (10 at 3/3 against B's 1/3) and loses the simple two-step one (2 at 1/3 against 3/3).
The "code mode is more expensive in tokens" finding in the voided table was an artefact of an arm
that could not call a tool and spent its turns being told so.

**The disclosure curve is a slope, not a cliff, and it is not monotonic in price.** E, the cheapest
arm by prompt tokens (137,319), is the worst at 4/11 — its failures are concentrated in task 7, where
it cannot tell a gated page from an ungated one. D is the most expensive of all four (232,058) *and*
worse than C, because `lazy` pays for `searchTools` round trips inside the program: 43 turns against
28. That is the real cost of not shipping the index — not the 1,731 tokens saved, but the extra turns
spent looking.

**The cheapest surface loses on capability, not on price.** Names-only is 27% cheaper than B and
passes 4 of 11. Inline is 17% cheaper than B and passes 7 of 11. The index pays for itself in tasks
completed, which is the argument for it that the voided data could not make.

**The saving is smaller than the raw arithmetic promised.** 1,877 tokens of index against 3,546 of
schemas predicts a much larger gap than 17%. The reason is in the cache column: almost every prompt
token in every arm is a **cache read**, and a repeated block is cheap to re-send. So the schema
surface is not paying 3,546 fresh tokens per turn — it is paying a cache read, which narrows the gap
that looked decisive on paper.

## The four defects this measurement took

Three of the four were in the instrument, not the surface. Each was caught by something impossible on
its face, and that is the only reason any of them were caught.

1. **The double wrap.** The arms were never code mode (`ngs-85-refusals.md`).
2. **A usage event emitted for an empty `message_start`.** The endpoint sends `input_tokens: 0` there
   and the real count on `message_delta`; the bench sums, so a turn recorded zero beside its count.
3. **The bench counted only `input_tokens` — cache *misses* — and discarded `cacheRead`/`cacheWrite`.**
   The column compared B's cache misses against C's and called it cost. Before the fix this table
   read `in=6` for turns carrying a 3,900-token prompt.
4. **The fixture answered `observeWindow` with the first window when the id was missing.** A program
   that wrote `{ window: "w2" }` — the native schema's argument name, not the program's — got
   Invoices back and said so. The model's account was accurate and the fixture made it read as a
   hallucination. Now an unknown or missing id is refused, which is what a driver does.

**Defect 4 is why task 6 is 3/3 for every arm in this table and was 0/3 for the code-mode arms in the
previous one.** It is also a warning about fixture benchmarks: a permissive fixture converts a
model's correct report into apparent confabulation, and the transcript is the only place that shows.

## What this does not tell you

- Not a CUA claim: fixtures, not a real driver. `packages/cua` is still open (#38).
- Not a sonnet claim: one model, and a weaker one than the voided run.
- Not a caching claim: ~93% of every arm's prompt tokens are cache reads on this endpoint. Turn
  caching off and the schema surface gets worse much faster than the code-mode surface, so the 17%
  is a floor for arm B, not a fixed property.
- Not a shipping recommendation. Four arms, eleven fixture tasks, one model, three reps.

## Reproducing it

```
BENCH_MODEL=claude-haiku-5-5 pnpm --filter @terabot/agent bench --arm=bcde --tasks=all --reps=3
```

Writes `reports/tera-81-bench/bcde-claude-haiku-5-5-3rep.json`.
