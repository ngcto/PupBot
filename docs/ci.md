# CI

`ci.yml` runs ten jobs. This file covers the two things that routinely confuse people looking at
the Actions tab, and nothing else — the workflow's own comments explain each gate.

## A cancelled run on a pull request is usually not a failure

`ci.yml` sets `cancel-in-progress` for pull requests, so pushing twice in a row cancels the first
run mid-flight. GitHub then creates a check for every job that was killed, and each one reports
`cancelled` — sometimes including a matrix leg whose name never expanded, which shows up literally
as `desktop (${{ matrix.os }})`.

**Read the newest run on the commit, not the loudest.** A branch with two runs on one SHA almost
always has a `cancelled` one and a `success` one, in that order:

```
gh run list --branch <branch> --limit 2 --json databaseId,headSha,status,conclusion
```

Pushes to `main` and scheduled runs do not cancel, because a merge should not kill a weekly run
that is halfway through.

**The phantom name is a cancellation race, not a property of the `name:` template**, so renaming
the job would not remove it. Measured over ten consecutive CI runs on 2026-11-21: one of four
cancelled runs carried a `desktop (${{ matrix.os }})` entry and none of six completed runs did, so
it appears on only some cancels. A matrix job's `name:` is also what distinguishes its legs on the
board, and collapsing it to a static string would make two distinct results read as one — a real
loss to buy nothing. Leave it as is.

## A green `ci` means every gate ran and passed

The aggregate `ci` job fails when any gate failed **or was skipped** — `cancelled` and `skipped`
are never read as a pass. Two gates are pull-request-only (`pr-hygiene`, `dependency-review`) and a
skip on a push is expected; every other gate must have actually run.

That matters for the checks that can pass without doing anything. `turbo run lint` only runs in
packages that declare a `lint` script, so `scripts/check-lint-coverage.mjs` fails when a package
ships source without one — and also when it cannot read a package at all. A coverage gate that
quietly covers nothing is the hole it exists to close.

## A stacked PR shows `CONFLICTING` and runs no CI, and it is usually neither

`pull_request` workflows only start once GitHub can build a merge ref. A PR it considers
unmergeable has no merge ref, so **no workflow runs at all** — the board is empty rather than red,
which reads as "nobody has looked yet" when the truth is "GitHub never tried".

Two things conspire, and both are artefacts of the stack rather than the code:

- **A squash-merge breaks the stack's ability to find the next base.** After the bottom layer
  lands as a squash, `gh stack sync` says `could not determine the previous base of <branch> after
  main changed; rebase this branch manually` and stops. The stack metadata keeps pointing at the
  pre-squash tree.
- **A PR based on a non-default branch** only ever gets `pull_request` runs. A dirty PR based on
  another PR therefore has no other trigger to fall back on.

What to check, in this order, before believing the conflict:

```
git merge-tree $(git merge-base origin/<base> origin/<head>) origin/<base> origin/<head> | grep -c '<<<<<<<'
gh run list --commit <head-sha> --limit 5
```

Zero conflict markers and zero runs means the code is fine and only the stack is stale. Replay it
by hand onto what actually landed, rather than waiting for the stack to catch up:

```
git rebase --onto origin/main <old-base-head>          # for the layer above a squash
git push --force-with-lease=<branch>:<old-remote-sha> origin <branch>
```

Then confirm the PR's diff against its base is only its own layer's files. When the layer above
merges, its own PR retargets to `main` on its own and lands as a correct replay — but only if the
stack metadata was refreshed by that push first.

## The release pipeline

`release.yml` is a different workflow with different rules. It runs on a `v*` tag, or by hand
(`workflow_dispatch`) with a version and an optional `dry_run`.

Six jobs. `meta` resolves the version and the commit; `desktop (linux)`, `desktop (windows)` and
`mobile (android)` build one installer each; `publish` collects them, writes the release notes, and
prints what the token holds; `release` creates the GitHub Release and uploads the assets.

The split between `publish` and `release` is deliberate, and two things follow from it:

- **`publish` and `release` each declare their own `contents: write`.** The permission surface of
  the job that writes to GitHub is one line wide, and it does not inherit anything from a job that
  only builds.
- **The bytes published are the bytes tested.** `release` re-downloads the artifacts the build jobs
  uploaded rather than rebuilding, so what a user gets is exactly what CI produced.

**A dry run skips the `release` job wholesale.** Not per step. If a step is added to `release`
later, the drill does not break — which matters, because a drill that needs maintenance every time
the release path changes is a drill whose failures get mistaken for real ones.

### The tag has to point at the workflow you want

Every build job checks out `needs.meta.outputs.sha`, and `meta` resolves the tag to a commit **from
the checkout of that tag**. So the workflow that runs is the one in the tagged commit, not the one
on `main`.

That has a consequence worth knowing before it costs an hour: **if you fix something in
`release.yml` and re-run the existing tag, nothing changes.** The tag still resolves to the old
commit and the old workflow. You have to move the tag onto the commit that contains the fix. Do
that only while nothing has been published from the old tag — once a release exists, the tag is the
record of what shipped it.

### What the release body says, and what the page shows

The release body states what is signed (nothing on Windows, debug-signed on Android) and what is
missing (macOS, iOS — both need a paid service). `apps/marketing/releases.ts` derives every download
URL from `apps/marketing/released.version.json`, which holds the version and the exact asset file
names a release actually carries. A platform whose build job failed is absent from that list, so its
button keeps saying "Coming soon" instead of pointing at a file that is not there.

Stamping that file is a human's job — the workflow prints a `release-site.patch` artifact rather
than pushing to a branch.

### A 403 from a workflow is the client's report, not GitHub's

The most expensive hour of this pipeline's construction came from reading a `403 Resource not
accessible by integration` as GitHub refusing the call. It was not. **The request had never been
made** — the step failed in front of it, and the real error was a JavaScript `SyntaxError` three
lines above the one being read (`Identifier 'octokit' has already been declared`, a scope collision
with `actions/github-script`). When that was fixed, `POST /releases` returned `201` on the first
attempt.

**Confirm the request was actually made before reasoning about why it was refused.** The check is
one `grep` of the job log for the line above the error, not a theory about token grants. Four
plausible permission theories were built on that status and all four were wrong, because none of
them could have been true of a call that did not happen.

### A filter that returns nothing is not evidence of nothing

The same day, closing two issues nearly went wrong the same way: `tools.issue.read` came back with
no assignee and no linked pull requests for both, which reads as "not mine, do not touch". Re-reading
returned both, assigned and in review.

**A filter or read that returns nothing for something you know exists is a degraded read, not an
absence.** Re-read it before acting on it — the cost of a second call is nothing next to acting on an
empty result that was never empty.
