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
