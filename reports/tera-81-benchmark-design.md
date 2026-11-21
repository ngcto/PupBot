# TERA-81 three-arm benchmark

The measurement that decides whether code mode ships. Fixed tasks, fixed model, fixed seed, three
arms. This file is the design; the tasks are written down **before** any run, so a task cannot be
chosen after seeing a result.

## The arms

| Arm | What it is | Attemptable today |
|---|---|---|
| **A** | The harness as `main` ships it — a chat loop with no tools at all. | yes |
| **B** | The same loop with the 26 CUA schemas inline as native tools. | **no** — needs #39's `RunTool` registry |
| **C** | The same loop with one `codemode` tool whose program calls the 26. | **no** — needs #39's registry |

Arms B and C are blocked on the `tools?: RunTool[]` parameter and `packages/agent/src/tools.ts`
that #39 adds to `run.ts`. This is not a formality: without the registry there is no place to put a
schema, so B and C cannot be attempted, and starting with arm A alone would produce a table with one
real column that reads as three.

The arms differ **only** in how a tool reaches the model. Same system prompt, same tasks, same
model, same temperature, same seed, same step cap.

## The four columns

| Column | How it is measured | Honest? |
|---|---|---|
| **Tokens** | `/v1/messages/count_tokens` on the exact request, summed across the run's turns | yes |
| **Turns** | Model calls per run, counted by the driver | yes |
| **Cost** | tokens × the endpoint's published per-million rates | yes |
| **Wall clock** | monotonic clock around each run on a **large** machine, reported as **two** numbers | only on a large box |

Wall clock is the column that lies, and it lies in two ways at once.

**First, it measures the box.** On a small machine the tool latency dominates and the number looks
like evidence while measuring the machine. It is measured on the large machine or it is left out
with a reason — never filled in from a small box.

**Second, it is ambiguous unless it says which clock it is.** So the table carries **two**
wall-clock columns and never a single one:

| Column | Starts | Stops | Contains |
|---|---|---|---|
| **Model time** | when the request is sent | when the last token of the reply arrives | model latency only |
| **Wall clock, inclusive** | before the first model call | after the last tool result is observed | model time **plus** tool time plus local compute |

The distinction decides how the table is read. An arm making twenty in-box calls and an arm making
twenty model turns have wildly different totals, and the interesting quantity is the *difference*
between the two columns: it is what the tools actually cost. A single "wall clock" number invites
the reader to assume whichever interpretation makes their preferred arm look right.

So: **`wall_ms_model` and `wall_ms_inclusive`, both always present, both from the same monotonic
clock in the same process.** A run that reports one without the other is not a result.

One column cannot be measured at all: **image tokens**. This endpoint accepts image blocks and does
not forward their pixels, so a screenshot's token cost does not track its size or content. Any task
whose answer needs a screenshot reports that cost as unmeasurable rather than estimating it. The
image probe in `reports/tera-81-measurements/image-probe.mjs` is the record of that failure.

## The ten tasks

Nine exercise the surface that exists. Task 10 replaces the original task 5 (a 10,000-row
spreadsheet read), which **no arm can attempt** because the 26-entry index contains no table,
spreadsheet, database or file tool — the capability is absent, not degraded. Its replacement tests
the same property through a tool that exists in arms B and C: a large result that must be filtered
before it reaches the model.

| # | Task | Property it tests | Tools it needs |
|---|---|---|---|
| 1 | Which apps are running, and which one owns the frontmost window? | Two cheap observations combined in one answer; arm A cannot attempt it at all. | `listApps`, `listWindows` |
| 2 | Open the app named in the task and report the window it created. | Acting, then observing the effect — the `effect` ladder's simplest case. | `launchApp` |
| 3 | In an open form, fill three fields and submit, then confirm the form closed. | A multi-step sequence with a verification step; in arm B this is three to five model turns, in arm C one program. | `observeWindow`, `typeText`, `click` |
| 4 | Find the element labelled with a given string in a window and click it, using the element token rather than coordinates. | Token discipline — acting on a fresh observation instead of a guessed point. | `observeWindow`, `click` |
| 5 | Repeat task 3 for 15 similar rows in one table, then report how many succeeded. | The turn-count property: 15 similar actions where arm B pays a turn each and arm C pays one program. | `runSteps` or `observeWindow` + `click` loop |
| 6 | Read a window's tree, and say whether anything in it is actionable at all. | Reading a large structured result and answering one question from it. | `observeWindow` |
| 7 | Navigate to a page, report the page title, and say whether a challenge gates it. | Browser path plus a state field that is not a failure — `captcha.gated` is state. | `prepareBrowser`, `browserNavigate`, `readPage` |
| 8 | Type into a page field by ref and confirm the value landed, without a screenshot. | Acting over CDP and verifying without an image, which is the honest path when image cost is unmeasurable. | `browserType`, `readPage` |
| 9 | A task where the first attempt fails: click a stale token, then recover and succeed. | Recovery. The CUA ladder returns `refused`/`unverifiable`; a correct run branches and retries rather than claiming success. | `click` (twice), `observeWindow` |
| 10 | **Replacement for the spreadsheet task.** From a 2,000-row accessibility tree, report how many rows are actionable and name the one whose label is "Approve invoice". | **Filtering a large result before the model sees it.** The property the original task 5 tested, through a tool that exists. | `observeWindow` |

### Why task 10 tests what it claims

A 2,000-row tree is not hypothetical: measured on a synthetic tree of that shape, the rows as JSON
cost **68,375 tokens** and as compact `[token] role "label"` lines **19,751**. Both are large enough
that the answer must be computed rather than read. Arm B must consume one of those whole to answer;
arm C filters in the program and returns two numbers. That is the filter property, and it is
reachable with a tool both arms have.

The rows are synthetic, and the table says so. The real tree's cost is TERA-74's measurement — 75
rows at 3,119 tokens as JSON against 1,213 as lines — and task 10 should be re-priced against a real
`observeWindow` result when a live computer is available, because a real tree has a different
role and label distribution from a synthetic one.

Arms B and C both attempt task 10. Arm A cannot, and that is the honest reason it is not counted
for A rather than a substituted score.

## Method

- **Model**: one model for every arm and every run. Recorded per run; a different model is a
  different benchmark.
- **Seed**: fixed where the endpoint supports it. Where it does not, three repetitions per arm and
  the **median** is reported, with the spread — a single run on a non-deterministic endpoint is an
  anecdote.
- **Step cap**: the harness's own cap, identical across arms. Arm A must not be given a different
  cap, because the cap is what makes a task fail for the wrong reason. (An earlier draft of this
  design proposed a third arm "A minus the step cap" to stop arm A failing task 7 for the wrong
  reason. That is now handled by reporting *which* arm failed *which* step of *which* task, so the
  failure mode is visible instead of being engineered away.)
- **Failure is a result, not a discard.** A run that fails is reported with its reason and its
  tokens spent. Dropping failed runs would make every arm look better in proportion to how often it
  fails.
- **No task is scored by the harness that ran it.** Correctness is checked by a validator that reads
  the transcript and the tool log, written before the runs.

## The command

    pnpm --filter @terabot/agent bench --arm=a --tasks=all --model=<id> --seed=1 --reps=3

The driver lands with the benchmark and writes `reports/tera-81-bench/<arm>-<model>-<seed>.json`
plus a Markdown table assembled from those files, so anybody can re-run it on any commit and get the
same shape. Until that command exists, this file describes an intention, not a result — and it
should not be quoted as evidence.

## What this benchmark cannot tell you

- **Nothing about wall clock on a small machine.** See above. And nothing from a single wall-clock
  number: the table carries `wall_ms_model` and `wall_ms_inclusive`, and the difference between
  them is the only honest statement about what tools cost in time.
- **Nothing about image cost.** Unmeasurable on this endpoint.
- **Nothing about the table/spreadsheet case.** No arm has the tool. If that case matters to the
  product, it needs a data tool first, and that is a separate decision from code mode.
- **Nothing about a task the index lacks any tool for.** §6.6 of the report is the list, and it is
  the first thing to check before calling a low score a harness failure.
- **Nothing about arms B and C until #39 lands.** A table with only arm A filled in is not a result.
