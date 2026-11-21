# TERA-81 — the code-mode table, re-measured

**This document replaces the code-mode table in `reports/tera-81-bench.md`, which is void.** All three
code-mode arms there were measured with `codemode` wrapped inside `codemode`, so the model received a
shell whose index listed one tool. See `reports/ngs-85-refusals.md`.

**Model: `claude-haiku-5-5`, every arm, every run, one sitting, 132 runs.** The earlier
`claude-sonnet-5-5` anchor is **retired, not superseded** — its measurements were void, so there is
nothing here to compare against.

## The table

| Arm | Cells | Turns | Prompt tokens (all, billed) | vs B | of which uncached | of which cached | Out tokens | Wall (model ms) |
|---|---|---|---|---|---|---|---|---|
| B — 26 native schemas | **7/11** | **30** | 213,618 | — | 82 | 161,227 | 7,962 | 96,377 |
| C — code mode, inline index | **7/11** | 33 | **188,930** | **−11.6%** | 88 | 117,462 | 6,783 | 92,181 |
| D — code mode, lazy (146 tok) | **7/11** | 45 | 228,899 | +7.2% | 112 | 158,824 | 8,185 | 118,470 |
| E — code mode, names (227 tok) | 6/11 | 28 | **131,887** | **−38.3%** | 78 | 72,534 | 7,030 | 81,711 |

Per cell, so variance is visible:

| Task | B | C | D | E |
|---|---|---|---|---|
| 1 list and name the apps | 3/3 | 3/3 | 3/3 | 3/3 |
| 2 launch an app | 3/3 | 1/3 | 3/3 | 1/3 |
| 3 fill two fields | 0/3 | 0/3 | 0/3 | 0/3 |
| 4 act and verify without an image | 3/3 | 2/3 | 1/3 | 2/3 |
| 5 multi-step sequence | 0/3 | 0/3 | 0/3 | 0/3 |
| 6 the tree is degraded | 3/3 | 3/3 | 3/3 | 3/3 |
| 7 a gated page | 3/3 | 2/3 | 2/3 | 3/3 |
| 8 act and confirm the value landed | 1/3 | 3/3 | 2/3 | 3/3 |
| 9 recover from a refusal | 2/3 | 1/3 | 3/3 | 1/3 |
| 10 filter a large tree | 1/3 | 3/3 | 0/3 | 0/3 |
| 11 answer without tools | 3/3 | 3/3 | 3/3 | 3/3 |

## What it says

**Code mode is level on correctness and 11.6% cheaper in prompt tokens, and it is not ahead on turns.**
Arm C ties B at 7/11 and 188,930 against 213,618 — but it spends **33 turns against 30**, so the saving
costs three extra round trips. That is a weaker result than the previous run of this same table gave
(−17%, same turns), and the difference is the fixture: the earlier run counted clicks that never
happened as successes, which made three arms look tidier than they are. **The number that survives
both runs is "level on correctness".**

**The turn count inverts the design claim.** Code mode exists to do several tool calls in one round
trip. Here it took *more* turns than the schema surface, because a program that observes, branches,
and observes again is three model calls when the branch changes what it needs. Task 10 is the counter-
example that keeps the argument alive — 3/3 against B's 1/3, filtering a large tree in code — but the
aggregate does not show a turn saving on this task set.

**The cheap variants are not cheap in what they cost you.** E is 38% cheaper and one cell behind;
D is more expensive than B *and* worse on turns (45), because `lazy` pays `searchTools` round trips
inside the program. D and C now tie B on cells, so the honest reading of the disclosure variants is:
**they cost turns or correctness, and none of them beats inline on the trade.** Inline remains the
default.

**Two tasks are 0/3 in every arm** — 3 and 5. Those are not the surface's fault and they should be
fixed or removed before another comparison; a cell nobody can pass contributes nothing but noise to
the denominator.

## The premise this work was commissioned on does not survive

The case for code mode was arithmetic: 26 tool schemas cost 3,546 tokens per request, one `codemode`
tool costs 1,877, so a program-per-turn surface must save tokens. That arithmetic is correct and it
priced the wrong thing.

**Most prompt tokens here are cache reads.** Across the arms, **62–76% of every arm's prompt tokens
are cache reads**, and the two surfaces' *uncached* remainders are nearly identical (82 tokens for B,
88 for C, across all eleven tasks). Two things follow. A repeated 26-schema block is not paid fresh
each turn, so the schema surface costs far less than the token counts implied — the measured gap is
11.6%, not several-fold. And a saving computed from token counts is only as good as the counts: this
benchmark's column read `input_tokens: 6` for a turn carrying a 3,900-token prompt, because 6 was the
uncached remainder. **Anyone reaching for "code mode saves tokens" should start here:** on a cached
endpoint it saves a fraction of a cache read per turn, not a schema block.

## The bar for revisiting the default

**`inline` stays the default and this table does not change it.** 11.6% at level correctness, three
extra turns, on one model, at three reps, does not move a default. The bar, recorded so it can be met
or missed explicitly:

1. **Five reps per cell**, not three — this table swings two cells on a single rep.
2. **A second model**, so the result is not a property of `claude-haiku-5-5`.
3. **The filtering tasks must still win** (task 10), and the turn count must at least match arm B.
   A surface that saves tokens and spends turns has not shown what it was designed to show.

## What a benchmark of this kind systematically gets wrong

It scores a log instead of a world, and every defect below came from that one fact.

Six defects were found in this measurement. **Five were places where the instrument said something
confident about an action that never happened:** a registry that merged two tools with one name and
silently shortened the tool list; an adapter that emitted a usage event for an empty `message_start`,
so a turn recorded zero tokens beside its real count; a token column that counted cache *misses* and
called it prompt size; a fixture that answered `observeWindow` with the *first window* when the id was
missing; and a fixture that returned `effect: "confirmed", verified: true, target: ""` for a **click
with no target**. In the last two cases the model's account was accurate and the score was wrong —
"the read for w2 returned the Invoices window" was a true statement about a lying fixture, and my
validator recorded it as failing to notice something.

The pattern is specific and worth naming: **an instrument that can invent a success will, and it will
look like a model failure.** A permissive fixture, a defaulted argument, a `confirmed` for an empty
target — each converts a correct report into apparent confabulation, and the score cannot tell the two
apart. The transcripts can, which is why the check that found all five was reading the model's own
words against the log rather than reading the score.

The second thing it gets wrong is subtler: **it measures what is easy to count.** Tokens and turns are
in the event stream, so they became the argument, and cost and correctness were assumed to be the
thing at stake. What actually decided this comparison was cache behaviour — a property of the endpoint
that appears in the counts only as a column nobody had opened. A benchmark that reports a number it
can compute and not the mechanism behind it will keep producing confident conclusions that a single
counterexample overturns.

## What we would do differently if we built the instrument first

**Make the fixture refuse anything it does not understand, and assert that before any run.**
Every invented success here was a default: a missing window id became the first window, a missing
token became a confirmed click, a missing `input_tokens` became a plausible small number. The rule is
one line — *a fixture with an argument set it cannot satisfy returns a refusal* — and it would have
caught two of the six before the first rep. It is now enforced, with tests, in `observeWindow` and
`click`.

**Assert the shape of the measurement itself before trusting a rate.** Not "did the run finish" but
"is this number possible": a turn's prompt cannot be 6 tokens when the system message alone is 98; a
tool list of 26 cannot become 1; a task cannot fail for refusing a window it was never given. Three of
the six defects were impossible on their face and sat in committed data for hours because nobody asked
the number to justify itself. A five-line pre-flight — sum the prompt tokens per turn, assert they
exceed the system prompt, assert the schema count the model received, assert no row reports an effect
without a target — turns each of those into a failed run instead of a published finding.

**And separate the instrument from the surface in time, not only in code.** Every defect here was in a
layer shared by all arms, which means each one moved every number at once and the comparison looked
coherent the whole time. Two of the six were found only because a model's prose contradicted a score.
The cheap version of that discipline: before comparing surfaces, run one arm twice and check the two
runs agree, with the transcripts read, not just the cells. A benchmark whose arms share a broken
instrument is not a weaker experiment than no experiment — it is a more convincing one.

## Reproducing it

```
BENCH_MODEL=claude-haiku-5-5 pnpm --filter @terabot/agent bench --arm=bcde --tasks=all --reps=3
```

Writes `reports/tera-81-bench/bcde-claude-haiku-5-5-3rep.json`.
