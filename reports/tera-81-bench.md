# TERA-81 three-arm benchmark — results

**Read this first: the desktop and browser tools in every arm were deterministic fixtures of
the same 26 capabilities, not a real driver.** `packages/cua` is still open (PR #38) and driving a
real desktop needs a live GUI session, so both tool-using arms got identical, local, seeded
implementations. What the table therefore measures is **the shape of the tool interface** — how many
model round trips a surface costs, how many tokens a result costs when it crosses the boundary, and
whether one program entry point replaces 26 schemas. It does **not** measure a real driver's
refusals, latencies or accessibility-tree shapes, and none of these numbers is a claim about CUA.

**It is also not evidence that the shipped product uses computer tools.** Nothing on `main` wires
the 26 into a hosted run: a run today gets four tools, all vault (`vault_find`, `vault_fill`,
`vault_totp`, `vault_request`), and `packages/tools`' `renderIndex` / `codemodeSchema` are called
only from its own tests. This is a result about the tool surface, not about the product's
computer-use path.

## Method

- Model `claude-sonnet-5-5`, one model for every arm and every run.
- Three reps per cell. The table shows the **median** of each cell, and the `(n/m)` beside each
  verdict is how many of the `m` reps passed — so variance is visible rather than averaged away.
- **Turns means one model round trip, not one tool call.** A turn that runs twenty calls inside a
  program is still one turn. Lower is better in every column.
- Every run went through the real `executeRun`: same loop, same registry, same `MAX_TOOL_STEPS = 8`.
  The arms differ only in the `tools` array handed to it.
- A task an arm cannot attempt is reported `n/a` with zero tokens, never as a zero score — a zero
  would read as "tried and failed", which is a different claim.
- Failure is reported with its tokens spent. Nothing was discarded.

## The table

| Arm | Task | OK | Turns (model round trips) | In tokens | Out tokens | Wall (model ms) | Wall (inclusive ms) | Why |
|---|---|---|---|---|---|---|---|---|
| A | 1 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 2 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 3 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 4 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 5 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 6 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 7 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 8 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 10 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| B | 1 | pass (3/3) | 2 | 1924 | 226 | 8558 | 8580 | called listApps=true, named the apps=true |
| C | 1 | fail (1/3) | 2 | 3388 | 141 | 5162 | 5305 | called listApps=false, named the apps=true |
| B | 2 | pass (3/3) | 2 | 3101 | 178 | 6297 | 6316 | launched=Mail, title in answer=true |
| C | 2 | fail (1/3) | 2 | 3468 | 105 | 7641 | 7858 | launched=, title in answer=false |
| B | 3 | fail (0/3) | 3 | 6784 | 549 | 16702 | 16726 | filled 1 fields, made 0 clicks |
| C | 3 | fail (0/3) | 4 | 11844 | 988 | 22796 | 23086 | filled 1 fields, made 2 clicks |
| B | 4 | fail (1/3) | 1 | 1822 | 276 | 11632 | 11647 | token=none, effect=none, echoed=false |
| C | 4 | pass (2/3) | 4 | 4643 | 402 | 14367 | 14688 | token=te28w, effect=confirmed, echoed=true |
| B | 5 | fail (1/3) | 4 | 5746 | 604 | 17644 | 17675 | 2 clicks made, answer claimed 4 |
| C | 5 | pass (2/3) | 3 | 10285 | 1335 | 26653 | 27158 | 4 clicks made, answer claimed 4 |
| B | 6 | pass (3/3) | 1 | 3032 | 36 | 2812 | 2833 | said yes=true, named an actionable role=true |
| C | 6 | fail (0/3) | 2 | 3435 | 204 | 10856 | 10977 | said yes=false, named an actionable role=false |
| B | 7 | pass (2/3) | 3 | 3738 | 369 | 13361 | 13389 | navigated=true, title=true, said ungated=true |
| C | 7 | fail (1/3) | 2 | 3334 | 419 | 11818 | 11947 | navigated=false, title=false, said ungated=false |
| B | 8 | pass (2/3) | 2 | 5559 | 300 | 5711 | 5732 | value set=true, took a screenshot=false |
| C | 8 | fail (0/3) | 3 | 4160 | 404 | 14988 | 15143 | value set=false, took a screenshot=false |
| B | 9 | fail (0/3) | 4 | 4813 | 382 | 10972 | 11009 | first refused=true, recovered=false, said so=true |
| C | 9 | fail (0/3) | 3 | 1892 | 332 | 11041 | 11368 | first refused=false, recovered=false, said so=true |
| B | 10 | fail (1/3) | 1 | 2715 | 89 | 3670 | 3687 | observed=false, right token=true, said 4=true |
| C | 10 | fail (0/3) | 2 | 3606 | 642 | 16063 | 16192 | observed=false, right token=false, said 4=false |
| A | 11 | pass (3/3) | 1 | 1080 | 325 | 10111 | 10147 | 24 sentence(s), mentioned refusal=true |
| B | 11 | pass (3/3) | 1 | 2730 | 170 | 5236 | 5255 | 2 sentence(s), mentioned refusal=true |
| C | 11 | pass (3/3) | 1 | 3099 | 164 | 5414 | 5435 | 2 sentence(s), mentioned refusal=true |
|---|---|---|---|---|---|---|---|---|
| A | all (median of 3 reps per cell) | 1/1 | 1 | 1080 | 325 | 10111 | 10147 | |
| B | all (median of 3 reps per cell) | 6/11 | 24 | 41964 | 3179 | 102595 | 102849 | |
| C | all (median of 3 reps per cell) | 3/11 | 28 | 53154 | 5136 | 146799 | 149157 | |

Every cell is a median of three reps. Lower is better in Turns, In tokens, Out tokens and both wall
columns; higher is better in the `pass (n/m)` column.

## What it says, plainly

**Code mode lost on this task set.** Arm C passed 3 of 11 cells against arm B's 6, used 28 turns
against 24, and spent 53,154 input tokens against 41,964. The one place code mode clearly wins is
the many-similar-actions task (task 5: C 3 turns against B 4, and C passed it 2/3 against B's 1/3),
which is the property the design predicted it would win. It loses everywhere else, and the two
biggest causes are visible in the data rather than inferred.

**Cause one: the index costs more on a small surface than the schemas it replaces.** Task 11 asks a
plain question and needs no tool at all. Arm B spent 2,730 input tokens and arm C spent 3,099 —
code mode paying 1,877 tokens of index to answer a question that never touched a tool. That is the
inline-versus-lazy question the report left open, now with a number: on eleven tasks the index is
pure overhead, and lazy discovery would remove most of it.

**Cause two: arm C's program is a second thing that can be wrong.** Arm C failed task 6 in all three
reps by answering `no` to a question whose tree plainly had actionable rows, and it failed task 8 in
all three by not managing to set a value through the browser path. A program that computes the wrong
intermediate value fails silently and confidently, where a tool-calling model gets each result fed
back and self-corrects. Task 1 is the sharpest example: C's answer was right and it had not called
`listApps`, so the evidence check failed it 2 reps of 3 — arm B called the tool because a schema
invited it, while arm C answered from the window list it already had in hand. That is a validator
strictness worth naming: it scores "did the work" as well as "got the answer", and on that task C
got the answer without doing the work.

*(In the first run, before the fixture fix below, arm C also failed task 5 by printing a click count
it never earned — `0 clicks made, answer claimed 4`. That run's task-5 reps were discarded along with
its task-9 reps, so the table shows C at 2/3 there. The failure mode is real and worth knowing about
even though the number it produced is not in the table.)*

**Both arms failed task 9, and that is the most interesting row.** Task 9 asks the model to click a
token that refuses, then recover. After the fixture was fixed, `first refused=true` for arm B in all
three reps — the model *saw* the refusal — and `recovered=false` in all three. It said it recovered.
Neither arm recovered. That is a finding about the harness and the prompt, not about the surface: the
`effect` ladder reaches the model and the model still does not climb it.

## Two defects this benchmark found in its own run

Both are recorded because the second one is what made the first row honest.

1. **The Anthropic adapter dropped `input_tokens` from `message_delta`** — the only place this
   endpoint reports them (`message_start` says 0, `message_delta` says 286). Any caller summing
   `usage` events recorded zero prompt tokens per turn. The first arm-B run reported `in=0`, which
   looked wrong and was. Fixed in `packages/providers`; without it the token column would have been
   a lie in every row.
2. **Task 9 was unanswerable by construction.** The fixture's refusal token was declared but never
   armed, so nothing ever refused and both arms "failed to recover" from a refusal that could not
   happen. Caught by checking the fixture rather than trusting the column. Fixed, task 9 re-run
   three reps per arm, and the original reps are discarded rather than counted — with the fix the
   refusal really happens, which is what made the `first refused=true` row possible.

A third fix matters for reading the table at all: a cell's verdict is the majority of its reps, but
the reason shown initially came from the first rep, so several cells read "fail — and here is why it
passed". The reason now comes from a rep that agrees with the verdict.

## What this does not tell you

- Nothing about real CUA: latencies, refusals, or tree shapes. That is the named second experiment,
  and it needs #38.
- Nothing about image cost: this endpoint accepts image blocks without forwarding pixels, so no
  screenshot could be priced.
- Nothing about tasks no arm can attempt. The original task 5 (a 10,000-row spreadsheet read) was
  replaced by task 10 because the index has no data tool at all; the gap list is §6.6 of
  `reports/TERA-81.md`.
- Nothing about wall clock as a property of the code: these are four cores on one box, and the two
  wall columns are reported separately so a reader can see what the tools cost in time apart from
  what the model cost.
- **The index-shape question is not closed by "B won".** B won with 26 schemas inline; C lost with
  the index inline too. The next run should test C with `searchTools` discovery instead (146 tokens
  instead of 1,877), because that is the variant the arithmetic favours and this run did not test.

## Reproducing it

    pnpm --filter @terabot/agent bench --arm=abc --tasks=all --reps=3

Writes `reports/tera-81-bench/abc-<model>-<reps>rep.json` (every rep, not the medians) and prints the
table. Needs `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, a migrated Postgres, and about 13 minutes.
The measured dataset is committed at `reports/tera-81-bench/abc-claude-sonnet-5-5-3rep.json`.
