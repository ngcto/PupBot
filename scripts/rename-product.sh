#!/usr/bin/env bash
#
# Rename the product across the working tree: PupBot becomes Terabot.
#
# One mechanical sweep for the whole tree, so a rebase that lands new
# `@pupbot/*` imports is fixed by re-running this file instead of by hand:
#
#   scripts/rename-product.sh            # rewrite the tree in place
#   scripts/rename-product.sh --check    # list the files it would rewrite
#
# Rewrites, in this order:
#   PupBot / Pupbot   -> Terabot   product name in prose, page titles, app metadata,
#                                  and the repository slug in README clone commands,
#                                  badge links and docs (ngcto/PupBot -> ngcto/Terabot)
#   PUPBOT            -> TERABOT   env prefixes, if any are introduced later
#   pupbot            -> terabot   package scope, db user/role/db names, container and
#                                  volume names, cookie prefix, storage keys, demo
#                                  emails, provider ids, log lines, service ids
#   Pup / pup         -> Tera/tera the seeded bot persona and the dev stub model id
#   pup-              -> tera-     ids that carried the short name (pup-stub)
#
# It reads tracked files only (git grep), so node_modules, build output,
# binaries and the git-ignored .env are never touched. Git history keeps
# the old name, which is correct.
#
# After it runs, `pnpm install` must be run once: package names changed and the
# lockfile has to agree with the manifests. If pnpm reports a broken lockfile
# (a workspace override carrying the scope name changes the peer graph), run
# `pnpm install --fix-lockfile` instead; it only re-resolves, no version moves.
#
# The only match the completeness gate allows to remain is this script, because
# it has to name the old value to map it. The script is therefore also excluded
# from its own rewrite, which makes a second run a no-op.

set -euo pipefail
cd "$(dirname "$0")/.."

SELF=':(exclude)scripts/rename-product.sh'
PATTERN='([Pp]up[Bb]ot|PUPBOT|\bPup\b|\bpup\b|\bpup-)'

mapfile -d '' files < <(git grep -l -z -I -E "$PATTERN" -- . "$SELF" || true)

if [[ "${1:-}" == "--check" ]]; then
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "nothing to rewrite"
  else
    printf '%s\n' "${files[@]}"
  fi
  exit 0
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "nothing to rewrite"
else
  perl -pi -e '
    s/PupBot/Terabot/g;
    s/Pupbot/Terabot/g;
    s/PUPBOT/TERABOT/g;
    s/pupbot/terabot/g;
    s/\bPup\b/Tera/g;
    s/\bpup\b/tera/g;
    s/\bpup-/tera-/g;
  ' -- "${files[@]}"
  printf 'rewrote %d files\n' "${#files[@]}"
fi

remaining="$(git grep -n -I -E "$PATTERN" -- . "$SELF" || true)"

if [[ -n "$remaining" ]]; then
  echo
  echo "still carrying the old name:" >&2
  echo "$remaining" >&2
  exit 1
fi

echo "clean: no old-name matches outside scripts/rename-product.sh"
