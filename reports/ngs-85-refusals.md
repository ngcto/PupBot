# NGS-85 — a program that walks past a refusal, and the arm that was never code mode

Two findings, and the second one is the larger.

The task I was given was to report refusals produced inside a program in the run summary. I built
that, and it works. But going to reproduce the defect first — the check I failed to run on NGS-83 —
turned up something worse: **all three code-mode arms in the benchmark were measured with `codemode`
wrapped inside `codemode`, so the model never saw a capability index at all.** Every number attached
to a code-mode arm in `reports/tera-81-bench.md` is void.

## 1. The wrap: arms C, D and E were never code mode

`executeRun` adds a `codemode` tool over the run's own registry. A benchmark arm already passed in
a tool named `codemode`. `createToolRegistry` keys by name, so the two collapsed into one entry — the
outer shell — whose index listed exactly one tool: `codemode`.

The model's own words, from arm C's task-9 reps in the committed dataset:

> "in this runtime only `codemode` is available to me, and calls to window/observation tools … are not available"

And the sandbox's answer to every honest tool name it tried:

```
- listWindows [failed]: there is no tool called "listWindows"
```

Reproduced without a model: in the doubly-wrapped arm, `tools.listWindows()` fails; the same call one
level in, through `tools.codemode({...})`, returns all three windows. `isCodeMode()` now detects a run
that already offers `codemode`, and `executeRun` skips the second wrap.

### What this invalidates

Everything the report said about code-mode arms, including the disclosure curve. The three findings I
published that are now known to be measuring a shell inside a shell:

- **"`lazy` (146 tokens) failed because a model cannot search for what it does not know exists."** In
  arm D the model was told the capability list was empty and was offered one tool named `codemode`.
  Its 20 "only codemode is available" answers were *accurate*. The lazy variant was never measured.
- **"`names` failed because a name does not say how to use it."** Arm E's `listApps` refusal was real,
  but it was refusing to a model that had been handed a shell with no index behind it.
- **"arm C passed 5 of 11."** Arm C's task-6 result — the one that moved from 0/3 to 3/3 after the
  bounded trace and became the report's largest effect — was produced by the doubly-wrapped arm.

The inline default stays, but **not because the alternatives lost**. They were never run. Inline is
the only variant with a working index behind it, which is a much weaker reason to prefer it.

### The honest partial re-run

The endpoint's quota ran out mid-run: 82 of 99 reps answered `403`. What survived, at three reps,
arm C only, tasks 1-6 — and it is **mixed, not an improvement**:

| Task | Before the wrap fix (void) | After |
|---|---|---|
| 1 | 1/3 | 2/3 |
| 2 | 1/3 | 3/3 |
| 3 | 0/3 | 0/3 |
| 4 | 2/3 | 1/3 |
| 5 | 2/3 | 1/3 |
| 6 | 3/3 | 1/2 |

Task 4 and task 5 got worse. That is the opposite of what a "the arm was broken and now it works"
story predicts, and it is worth stating rather than smoothing: fixing the wrap gave the model a real
index to work from and it did not uniformly do better with one. **No full code-mode table exists.** The
dataset is committed as `c-after-wrapfix-partial-claude-sonnet-5-5.json` and is marked partial.

## 2. The refusal reporting, which was the task

Built as specified: reported, never raised; bounded and shaped like the trace; nothing when there
were no refusals; and worded as a claim about the program's output rather than a log line.

```
Clicked the invoice element.
an action was refused while your program ran (click).
A refusal is information, not a crash, so the program carried on past it. Unless you checked
`effect` after each call, treat your output as unverified — it may describe a step that never happened.
- click stale_token: that token is from an older snapshot
[1 tool call, 1 refused. 21 ms in the sandbox; ...]
```

A refusal is recognised by shape (`effect: "refused"`) in the sandbox, so no driver is imported to
notice one, and `refused` sits beside `ok` rather than replacing it — a refusal resolves, because it
is information a program branches on. The ladder's contract is unchanged; nothing throws.

It also fixed a miscount that was doing real damage: **`3 tool calls succeeded` was printed for a
program whose click had been refused.** A refusal is neither a failure nor a success, and the summary
now says `1 refused`.

### The measurement

Task 9, three reps, through `executeRun`, in the order that isolates the two changes:

| Arm C, task 9 | Result |
|---|---|
| Both fixes (refusal reporting + wrap fix) | **1/3** |
| Wrap fix only, refusal reporting reverted (ablation) | **0/3** |
| Before either (committed dataset) | 0/3 |

**It moved, and the ablation says it moved because of the refusal report.** With the wrap fixed and
the report absent, 0/3; with the report present, 1/3 — and the failing reps in the ablation claimed a
clicked element, which is exactly the confident-answer-on-a-refusal the warning exists to prevent.

Arm C has still never passed task 9 twice in three reps, and one pass is one pass. But the mechanism
the Captain predicted is visible in the rep that failed with the report in place: it *did* read the
refusal and describe it correctly, and still did not re-observe. So both halves are now on the record:
the program can be told, and being told is not sufficient.

## What I would do next, and what I would not claim

- **Do not quote any code-mode number from `tera-81-bench.md`.** The code-mode table needs a full
  re-run once the endpoint's quota resets; the partial above is not a substitute.
- **`inline` is the default with less justification than before**, not more. The arithmetic argument
  against 1,877 tokens still stands and the cheap variants still have no measurement behind them.
- **Task 9's arm-C result is a single pass.** It is evidence that the reporting path works, not
  evidence that code mode recovers better than it did.
