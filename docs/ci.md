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

## A green `ci` means every gate ran and passed

The aggregate `ci` job fails when any gate failed **or was skipped** — `cancelled` and `skipped`
are never read as a pass. Two gates are pull-request-only (`pr-hygiene`, `dependency-review`) and a
skip on a push is expected; every other gate must have actually run.

That matters for the checks that can pass without doing anything. `turbo run lint` only runs in
packages that declare a `lint` script, so `scripts/check-lint-coverage.mjs` fails when a package
ships source without one — and also when it cannot read a package at all. A coverage gate that
quietly covers nothing is the hole it exists to close.
