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

The pattern from four defects in one benchmark, three found by asking why a *number* looked wrong and
the fourth by asking why a *behaviour* looked wrong:

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

## What a green board does and does not mean

A green board means the change is shippable. It does not mean the change does what was asked. For
anything behavioural — a harness, a loop, a tool surface — the evidence is a measurement or a run
against the real thing, and CI is only the floor.
