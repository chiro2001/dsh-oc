#!/usr/bin/env bash
# List or delete branches already merged into the target branch.
#
# Usage:
#   bash scripts/cleanup-merged-branches.sh [target] [--apply] [--remote]
#
# Default target is `main`. Without --apply this only lists candidates.
# --apply deletes local merged branches (skipping those still checked out in
# a worktree); --remote additionally deletes them on origin. All listed
# branches are fully contained in the target, so deletion loses no commits.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="main"
APPLY=0
REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remote) REMOTE=1 ;;
    *) TARGET="$arg" ;;
  esac
done

git fetch --prune origin >/dev/null 2>&1 || true
KEEP="^(main|develop|${TARGET})$"
local_merged="$(git branch --merged "$TARGET" | sed 's/^[*+ ] //' | rg -v "$KEEP" || true)"
remote_merged="$(git branch -r --merged "$TARGET" \
  | sed 's/^[*+ ] //' \
  | rg -v '^origin/(main|develop|HEAD|'"${TARGET}"')([[:space:]]|$)' \
  | sed 's|^origin/||' \
  | rg -v "$KEEP" || true)"
merged="$(printf '%s\n%s\n' "$local_merged" "$remote_merged" | sed '/^$/d' | sort -u)"

if [[ -z "$merged" ]]; then
  echo "cleanup-merged-branches: no merged branches to clean (target: $TARGET)"
  exit 0
fi

echo "cleanup-merged-branches: branches merged into $TARGET"
echo "$merged" | sed 's/^/  /'

if [[ "$APPLY" != "1" ]]; then
  echo "dry-run: pass --apply to delete local branches; --remote also deletes on origin"
  exit 0
fi

for branch in $merged; do
  if git worktree list --porcelain | rg -q "branch refs/heads/${branch}$"; then
    echo "skip (checked out in a worktree): $branch"
    continue
  fi
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git branch -d "$branch"
  fi
  if [[ "$REMOTE" == "1" ]]; then
    if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      git push origin --delete "$branch"
    fi
  fi
done
