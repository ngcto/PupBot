# Reading CI when it fails

Two things about this repository's CI cost a round each on 2026-11-21, and both look like a
failure when they are not. Read this before reacting to a red board.

## Nine checks cancelled at once is the concurrency group, not a failure

`.github/workflows/ci.yml` sets a workflow-level concurrency group of
`${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: ${{ github.event_name ==
'pull_request' }}`. So a pull request gets one run at a time: push twice in quick succession and
the earlier run is cancelled — every job under it reports `cancelled`, and the `ci` aggregator
job then fails because its children did not pass. The group renders as
`CI-refs/pull/<n>/merge`, which is where the annotation's wording comes from.

The board then reads like a catastrophe: `build`, `test`, `static`, `e2e`, `desktop`, `security`,
`setup`, `pr-hygiene` and `dependency-review` all failing within seconds of each other.

**The failing job's log will not tell you why.** `gh run view --job <id> --log-failed` on the
aggregator prints only what it printed at the end:

```
FAIL  static: cancelled
FAIL  test: cancelled
8 gate(s) did not pass
```

That is the aggregator restating its children's results. It is a symptom and it names no cause.

**The run summary does tell you.** `gh run view <run-id>` puts the cause in the annotations:

```
X Canceling since a higher priority waiting request for CI-refs/pull/46/merge exists
```

So: when several checks fail at once and the timings are near zero, run `gh run view <run-id>` and
read the annotations before reading any job log. Then look for the *newest* run on the same head —
the one that was not cancelled — and read that board instead. The superseded run's results are
noise and should not be reported as a failure to anyone.

## `Vercel` fails on quota, not on code

Every pull request carries a `Vercel` check. On the free plan it fails after 100 deployments in a
day, and the check's URL is the tell:

```
https://vercel.com/<team>?upgradeToPro=build-rate-limit
Deployment rate limited — retry in 24 hours.
```

That is not a defect in the branch, it does not clear by re-running, and it should be reported as
a quota block with that URL quoted rather than as a failing gate.

For reference, `ci.yml` defines nine gate jobs — `setup`, `static`, `test`, `build`, `e2e`,
`desktop`, `pr-hygiene`, `security`, `dependency-review` — plus the `ci` aggregator that fails if
any of them did not pass. `desktop` is a two-entry matrix, so a clean pull request reads as **eleven** green checks from
this workflow, **twelve** with `CodeQL`, and **thirteen** once a `Vercel` deploy succeeds. Those
are the counts observed on this repository, not a guess: one board read thirteen checks, of which
twelve passed and `Vercel` did not. Count them before concluding something is missing.

## `ECONNREFUSED ::1:5432` means the machine slept, not that `main` is red

If `pnpm test` fails `@terabot/db` with:

```
Error: connect ECONNREFUSED ::1:5432
Error: connect ECONNREFUSED 127.0.0.1:5432
```

then **the machine slept and its Docker containers are gone.** That is not a red `main`, not your
branch, and not something to report to anyone as a failing change. A cloud machine stops its
processes about two minutes after a run goes idle, so any morning's first `pnpm test` on a machine
that has been asleep will show this.

The same is true of an un-migrated schema, which fails later and more confusingly:

```
column "managed" of relation "computer_account" does not exist
```

Both are environment state. The fix is the repo's own commands, which are also the Setup's
`postgres` and `migrate` entries:

```
docker compose up -d postgres
pnpm db:migrate
```

Run those before believing a red test suite on a machine that has been asleep, and say
"environment, then green" when reporting it — never report an un-migrated database as a failing
change, and never "fix" it in a pull request.

## When a result looks wrong, ask whether the thing you measured would do that

The pattern from five defects in one benchmark, three found by asking why a *number* looked wrong,
one by asking why a *behaviour* looked wrong, and one — the largest — by trying to reproduce the
defect before fixing it:

- A token column read `input_tokens: 0`. Suspicious, so I checked — an adapter was dropping the field,
  and every row would have been a lie.
- A task was failed by both arms in every rep. The transcripts said the model recovered correctly;
  the scorer demanded something the fixture made impossible. **A validator that cannot pass looks
  exactly like a capability that is missing.**

The check is the same one this file already applies to CI: **before theorising about why something
was refused or why a number is bad, confirm the request was made and that the thing you measured
could have produced that result.** A model that ignored a refusal and a scorer that never let it pass
produce identical output.

Corollary worth keeping: if a fix would have looked like an improvement on re-test, that is a reason
to distrust it, not to ship it. A prompt change made to solve a defect nobody demonstrated will
"work" the second time, for the same wrong reason.

## "Only X is available to me" is a report about the harness, not about the model

The fifth defect in that benchmark, and the one that invalidated the most: a tool named `codemode`
swallowed an arm that was already `codemode`, because the registry that holds tools is keyed by name.
Two tools with one name merge into one, and nobody notices a tool list that got *shorter*.

The models said so, plainly, in three separate runs:

> "in this runtime only `codemode` is available to me"

> "the available tools in this environment don't include `listWindows`/`observeWindow`"

Those lines were sitting in the dataset as **evidence** — quoted in a filed issue, read as a model
rationalising a failure — while being a correct description of the harness. The sandbox had already
answered every honest tool name with `there is no tool called "listWindows"`.

**The tell: when a model reports that its capabilities are emptier than you know they are, believe
the report and go and check the tool list you assembled. It is cheap to check and it is almost never
the model.** A model inventing a limitation and a harness failing to offer a capability produce the
same sentence, and only one of them is worth debugging in the prompt.

This is the same mistake as the `403` at the top of this file: a report of a problem, taken as the
problem. The model's message is a *client's* description of what it received — exactly like an HTTP
error is a client's description of the response — and the instrument to check it is on our side.

## A stacked PR's `mergeable` is computed against the trunk, not its base

GitHub reports mergeability for a pull request in a **native stack** against the stack's **trunk** —
`main` — not against the base branch the pull request declares. On a four-layer stack that means
every layer's board is answering a question nobody asked: "would this merge into `main` on its own",
when the answer that matters for landing is "does it contain its parent".

The failure mode is silent in both directions, and both were hit on the billing stack on 2026-11-21:

- **A clean stack reads `CONFLICTING`.** Every layer-to-layer merge was a fast-forward
  (`git merge-base --is-ancestor` said yes, `git merge --no-ff <parent>` said "Automatic merge went
  well"), while layers 3 and 4 genuinely conflicted with `main` in four files. Nothing local said so.
- **Replaying the tip is not enough.** The conflict was introduced in layer 3 and only touched lines
  layer 4 never edited, so replaying layer 4 onto a rebased layer 3 succeeded while layer 3 itself
  still could not merge.

**The check that tells the truth, per layer:**

```bash
git fetch origin main
for b in layer1 layer2 layer3 layer4; do
  printf '%-24s ' "$b"
  git merge-tree --write-tree origin/main "$b" >/dev/null 2>&1 && echo CLEAN || echo CONFLICT
done
```

`git merge-tree --write-tree` answers "would this merge cleanly" without touching a working tree, so
it is safe to run over every branch of a stack at once. Do it **before** pushing a replay, not after.

Two more things that make local merges lie:

- **`git merge-base --is-ancestor <parent> <child>` proves lineage, not mergeability.** A child can
  contain its parent exactly and still be unmergeable into the trunk.
- **`rerere` replays an old resolution as if it were a clean merge.** If `git config rerere.enabled`
  is `true`, a repeated replay of the same conflict resolves itself and prints "Automatic merge went
  well". Test with `-c rerere.enabled=false`, or from a fresh clone, before believing it.

Finally: after a layer is **squash-merged**, GitHub retargets the next pull request to the squash's
base and recomputes against the new `main`. A `CONFLICTING` reading immediately afterwards is usually
the stack standing behind a squash — replay it, do not treat it as a defect in what you wrote.

## What a green board does and does not mean

A green board means the change is shippable. It does not mean the change does what was asked. For
anything behavioural — a harness, a loop, a tool surface — the evidence is a measurement or a run
against the real thing, and CI is only the floor.
