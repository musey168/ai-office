#!/usr/bin/env bash
#
# Syncs the `upstream` branch with the upstream repository.
#
# The branch carries **no changes of ours** — it is exactly upstream's
# `main`, so that merging upstream into the development branch is one
# merge with a known diff.
#
#   web/tools/sync-upstream.sh          # fetch and fast-forward
#   web/tools/sync-upstream.sh --merge  # …and merge it into dev
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

echo "→ fetching upstream"
git fetch upstream main

echo "→ moving the upstream branch to upstream/main"
git branch -f upstream upstream/main
git push origin upstream --force-with-lease

echo
echo "upstream: $(git rev-parse --short upstream/main)"

if [ "${1:-}" = "--merge" ]; then
  current="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$current" != "dev" ]; then
    echo "refusing to merge into '$current' — switch to dev first" >&2
    exit 1
  fi
  echo "→ merging upstream into dev"
  git merge --no-edit upstream/main
  echo
  echo "合并完成。冲突解决后："
  echo "  git add -A && git commit && git push origin dev"
fi
