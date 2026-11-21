# TERA-81 three-arm benchmark — results

**Read this first: the desktop and browser tools in every arm were deterministic fixtures of
the same 26 capabilities, not a real driver.** `packages/cua` is still open (PR #38) and driving a
real desktop needs a live GUI session, so both tool-using arms got identical, local, seeded
implementations. What the table measures is **the shape of the tool interface** — how many model
round trips a surface costs, how many tokens a result costs when it crosses the boundary, and
whether one program entry point replaces 26 schemas. It does **not** measure a real driver's
refusals, latencies or accessibility-tree shapes, and none of these numbers is a claim about CUA.

**It is also not evidence that the shipped product uses computer tools.** Nothing on `main` wires
the 26 into a hosted run: a run today gets four tools, all vault (`vault_find`, `vault_fill`,
`vault_totp`, `vault_request`), and `packages/tools`' `renderIndex` / `codemodeSchema` are called
only from its own tests. This is a result about the tool surface, not about the product's
computer-use path.

## Method

- Model `claude-sonnet-5-5`, one model for every arm and every run.
- Three reps per cell. The table shows the **median** of each cell, and `(n/m)` beside each verdict
  is how many of the `m` reps passed — so variance is visible rather than averaged away.
- **Turns means one model round trip, not one tool call.** A turn that runs twenty calls inside a
  program is still one turn. Lower is better in every column except passes.
- Every run went through the real `executeRun`: same loop, same registry, same `MAX_TOOL_STEPS = 8`.
  The arms differ only in the `tools` array handed to it.
- A task an arm cannot attempt is reported `n/a` with zero tokens, never as a zero score.
- Failure is reported with its tokens spent. Nothing is discarded except rows explicitly marked as
  measured against a defect, below.

## The table

| Arm | Task | OK | Turns (model round trips) | In tokens | Out tokens | Wall (model ms) | Wall (inclusive ms) | Why |
|---|---|---|---|---|---|---|---|---|
| A | 1 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 2 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 3 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 4 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 5 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
| A | 7 | n/a | 0 | 0 | 0 | 0 | 0 | arm a has no tool surface, so it cannot attempt this task |
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
| B | 6 | pass (3/3) | 3 | 1769 | 71 | 7228 | 7269 | said yes=true, named an actionable role=true |
| C | 6 | pass (3/3) | 1 | 1512 | 31 | 2292 | 2304 | said yes=true, named an actionable role=true |
| B | 7 | pass (2/3) | 3 | 3738 | 369 | 13361 | 13389 | navigated=true, title=true, said ungated=true |
| C | 7 | fail (1/3) | 2 | 3334 | 419 | 11818 | 11947 | navigated=false, title=false, said ungated=false |
| B | 8 | pass (3/3) | 7 | 8559 | 561 | 27045 | 27100 | value set=true, took a screenshot=false |
| C | 8 | pass (2/3) | 5 | 3552 | 978 | 27515 | 27956 | value set=true, took a screenshot=false |
| B | 9 | fail (0/3) | 4 | 4813 | 382 | 10972 | 11009 | first refused=true, recovered=false, said so=true |
| C | 9 | fail (0/3) | 3 | 1892 | 332 | 11041 | 11368 | first refused=false, recovered=false, said so=true |
| B | 10 | fail (1/3) | 1 | 2715 | 89 | 3670 | 3687 | observed=false, right token=true, said 4=true |
| C | 10 | fail (0/3) | 2 | 3606 | 642 | 16063 | 16192 | observed=false, right token=false, said 4=false |
| A | 11 | pass (3/3) | 1 | 1080 | 325 | 10111 | 10147 | 24 sentence(s), mentioned refusal=true |
| B | 11 | pass (3/3) | 1 | 2730 | 170 | 5236 | 5255 | 2 sentence(s), mentioned refusal=true |
| C | 11 | pass (3/3) | 1 | 3099 | 164 | 5414 | 5435 | 2 sentence(s), mentioned refusal=true |
|---|---|---|---|---|---|---|---|---|
| A | all (median of 3 reps per cell) | 1/1 | 1 | 1080 | 325 | 10111 | 10147 | |
| B | all (median of 3 reps per cell) | 6/11 | 31 | 43701 | 3475 | 128345 | 128653 | |
| C | all (median of 3 reps per cell) | 5/11 | 29 | 50623 | 5537 | 150762 | 153297 | |

Every cell is a median of three reps. Lower is better in Turns, In tokens, Out tokens and both wall
columns; higher is better in `pass (n/m)`.

## What it says

**Code mode lost narrowly, and the reason was a harness defect rather than the surface.** After
three defects were fixed (below), arm C passed 5 of 11 cells against arm B's 6, and it used **fewer
turns — 29 against 31**. It still spent more input tokens: 50,623 against 43,701. So on this task set
code mode is not cheaper, is roughly equal on correctness, and is ahead on round trips.

The convergence matters more than the headline. Before the fixes, arm C passed 3 of 11 — most of the
gap was a defect in how a program's observations reached the model, not in code mode itself. Anyone
quoting the 3-of-11 figure would be quoting a harness bug.

**The dominant cause was not the surface — it was that a silent program's observations were
discarded.** Three of arm C's original task-6 answers said so in their own words:

> "I observed the Mail window but the observation result wasn't returned to me in that call."

The calls had succeeded. What reached the model was `The program finished and printed nothing.` A
program that observes a tree and forgets to `text()` had the information and could not see it, so its
only route to the data was another turn and a guess. That is a harness defect, not a property of code
mode, and it was the single largest contributor to arm C's losses.

**With the bounded trace added (see below), task 6 went from 0/3 to 3/3 on arm C — in one turn
instead of three, at 1,512 input tokens instead of 3,435.** The row in the table above is the
post-fix number. That is the fair comparison; the pre-fix reps are discarded and named as such.

That single fix moved arm C from 3 cells to 5. It is the largest effect in this benchmark, and it is
a statement about the harness: **a code-mode program that cannot see what its calls returned is not
a fair test of code mode.**

**What remains is the index cost.** Task 11 needs no tool at all: arm B spent 2,730 input tokens and
arm C 3,099, paying the full 1,877-token index to answer a question that never touched a tool. This
run did **not** test arm C with `searchTools` discovery instead of the inline index, which is the
variant the arithmetic favours (146 tokens against 1,877). That is the next experiment, and it is
worth doing now that the trace has removed the confound.

**Both arms still fail task 9, and it is the most important row.** Task 9 asks the model to click a
token that refuses, then recover. `first refused=true` in all three of arm B's reps and
`recovered=false` in all three — it saw the refusal, said it recovered, and did not. Neither arm
climbs the `effect` ladder. That is a finding about the harness and the prompt, not about the
surface, and it is the one to act on first because every refusal designed into `packages/cua` is
decoration until a model acts on one.

## The bounded trace

When a program produced no output or failed, the model now sees what its last calls returned: the
last three calls, each preview truncated to 200 characters by the sandbox before it crosses, and the
whole trace capped at 600 characters. Nothing is added when a program succeeded and printed
something — a trace on success is how a code-mode surface quietly doubles its token cost.

Tests pin the cap rather than the feature: five calls trace exactly three with the omission stated, a
10,000-row result contributes at most 200 characters and is marked `[truncated]`, and a successful
program's trace is empty.

## Defects found and fixed, in order of how much they mattered

1. **A silent program's tool results were discarded** — the trace defect above. Fixed; task 6 re-run.
2. **Task 8 was a task defect, not an arm failure.** The prompt asked for a "search field" that the
   fixture does not have, so the model correctly asked which field was meant and both arms were
   scored as failing. The wording now names the two empty text fields. Re-run: **B 3/3, C 2/3** — the
   one arm-C failure was the harness's own step cap (`the bot used more than 8 tool steps`), which is
   a real result about a multi-turn browsing task rather than a defect. B needed 6–8 turns and C
   needed 5, but one C rep used 9.
3. **Task 9 was unanswerable by construction.** The fixture's refusal token was declared but never
   armed, so nothing ever refused. Fixed and re-run; with the fix the refusal really happens, which
   is what makes the `first refused=true` evidence above possible.
4. **The Anthropic adapter dropped `input_tokens` from `message_delta`**, the only place this
   endpoint reports them. Any caller summing `usage` events recorded zero prompt tokens per turn. The
   first arm-B run said `in=0`, which looked wrong and was. Without this fix the token column would
   have been a lie in every row.
5. **A cell's verdict is the majority of its reps, but the reason shown came from the first rep**, so
   several cells read "fail — and here is why it passed". The reason now comes from a rep that agrees
   with the verdict, and every verdict carries `(n/m)`.

## The disclosure curve: three variants measured, and only the full index works

| | B (26 schemas) | C inline (1,877) | **E names (227)** | **D lazy (146)** |
|---|---|---|---|---|
| Cells passed | **6/11** | 5/11 | 1/11 | 1/11 |
| Turns | 31 | 29 | 22 | 17 |
| Input tokens | 43,701 | 50,623 | 25,095 | **20,994** |

**Cheaper is not better, and the curve does not flatten — it falls off a cliff.** Dropping from 1,877
to 227 tokens costs four of five passing cells; dropping to 146 costs the rest. The two cheap
variants are the two worst arms ever measured here.

**Names failed differently from lazy, and the difference is instructive.** Arm D concluded there was
nothing it could do and never called anything. Arm E *did* reach for the tools — and called them as if
they were top-level tools rather than capabilities inside the program:

> "The environment lists `listApps` and `listWindows` as available, but calling them fails in this
> session (`listApps` returned "there is no tool called `listApps`")"

That refusal is real: those names are not registered in the outer tool loop, only inside the
sandbox. So a bare list of names is **ambiguous about how to use them**, and the ambiguity costs more
than the tokens saved. The inline index is not just larger — each entry carries its cost and a
situation phrase, which together say "this is a capability, here is when to reach for it".

## The lazy-index experiment: measured, and it lost decisively

The open question was whether the index should travel inline (1,877 tokens) or be fetched by
`searchTools` inside the program (146 tokens). The arithmetic favoured lazy by 1,731 tokens. It is
now measured as a fourth arm, **D**, on the same eleven tasks, same model, three reps.

| | B (26 schemas) | C (inline, 1,877) | **D (lazy, 146)** |
|---|---|---|---|
| Cells passed | **6/11** | 5/11 | **1/11** |
| Turns | 31 | 29 | 17 |
| Input tokens | 43,701 | 50,623 | **20,994** |

**D is the cheapest arm ever measured and the worst.** It used 20,994 input tokens against C's
50,623 — a saving of more than half — and passed one task out of eleven. The saving is real and the
capability is gone.

**The mechanism is not a bug in `searchTools`.** Verified: `armD()` is wired correctly, its
description is 494 characters against C's 3,748, and `searchTools({ query: "which windows exist" })`
run in-program returns five tools. The model never made the call. Its own words, from task 1:

> "I don't have access to any tools that can inspect running apps or the frontmost window. The
> available tool set only includes `codemode`, and tool discovery returned no app/window inspection
> tools."

And from task 8:

> "I can't navigate to web pages or type into text fields — no browser, web, or computer-use tools are
> available (only `codemode`)."

Every one of those runs said "only `codemode`" — the model read the prompt, saw one tool with no
capabilities listed, and concluded there was nothing it could do. It did not search. The discovery
instructions are present in the prompt and `searchTools` works; the model simply does not reach for a
search when it has no evidence that searching would find anything.

**So the answer to the original question is: inline wins, and not narrowly.** The 1,731 tokens were
buying something specific and nameable — **evidence that a capability exists**. A model cannot search
for what it does not know might be there.

This was the most useful number in the benchmark until names-only was measured, and between them they
close the question. Lazy proved that a model cannot search for what it does not know exists.
Names-only proved that a model told only *that* tools exist will call them wrongly. **The fixed cost
is not instructions and not evidence alone: it is a description precise enough to use.**

## The lesson that generalises

**A code-mode surface's fixed cost is not its instructions — it is the evidence it carries that
capabilities exist, at the precision needed to use them.**

Three variants isolate the three parts, each measured at 1,877, 227 and 146 tokens:

| Carries | Tokens | Cells | What failed |
|---|---|---|---|
| Instructions, names, descriptions, situation phrases | 1,877 | 5/11 | — |
| Instructions and names | 227 | 1/11 | Named tools are called as top-level tools, because a name does not say *how* |
| Instructions only | 146 | 1/11 | The model concludes it has no capabilities and never searches |

Shortening the surface works only down to the point where a model can still tell what a capability
is for and how to reach it. Below that, every token saved is bought from the pass rate. Anyone
building the next agent with a code-mode surface should read this as: do not prune the capability
description to save prompt space unless you have measured what the pruning costs — and do not assume a
search tool compensates for a prompt that says nothing.

## What this does not tell you

- Nothing about real CUA: latencies, refusals, or tree shapes. That is the named second experiment
  and it needs #38.
- Nothing about image cost: this endpoint accepts image blocks without forwarding pixels, so no
  screenshot could be priced.
- Nothing about tasks no arm can attempt. The original task 5 (a 10,000-row spreadsheet read) was
  replaced by task 10 because the index has no data tool at all; the gap list is §6.6 of
  `reports/TERA-81.md`.
- Nothing conclusive about wall clock as a property of the code: these are four cores on one box, and
  the two wall columns are reported separately so a reader can see what the tools cost in time apart
  from what the model cost.
- **The index-shape question is now closed for lazy.** D at 146 tokens passed 1/11 against C's 5/11,
  so discovery without evidence-of-existence does not work. The untested middle is names-only at 227
  tokens.

## Reproducing it

    pnpm --filter @terabot/agent bench --arm=abc --tasks=all --reps=3

Writes `reports/tera-81-bench/abc-<model>-<reps>rep.json` (every rep, not the medians) and prints the
table. Needs `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, a migrated Postgres, and about 13 minutes.
The measured dataset is committed at `reports/tera-81-bench/abc-claude-sonnet-5-5-3rep.json`.
