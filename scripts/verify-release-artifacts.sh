#!/usr/bin/env bash
# Release artifact audit (rc.2 gate, round-0002 recommendation):
#  1. rebuild lib/ from the committed sources in a pristine archive and
#     require zero diff against the committed lib/;
#  2. pack the npm tarball and scan it for machine absolute paths;
#  3. record package version, tarball sha256 and a package-tree hash so a
#     release commit can be referenced immutably.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-oc-artifacts.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== release artifact audit (HEAD=$(git rev-parse HEAD)) =="
mkdir -p "$TMP/pristine" "$TMP/build" "$TMP/unpack" "$TMP/pack"

git archive --format=tar HEAD | tar -x -C "$TMP/pristine"
git archive --format=tar HEAD | tar -x -C "$TMP/build"
# Reuse the current install so the audit does not re-resolve dependencies;
# the archive's own node_modules is excluded from the tarball by `files`.
ln -s "$REPO_ROOT/node_modules" "$TMP/build/node_modules"

echo "-- clean rebuild --"
(cd "$TMP/build" && pnpm build >/dev/null)
if ! diff -r "$TMP/pristine/lib" "$TMP/build/lib" > "$TMP/lib.diff" 2>&1; then
  echo "FAIL: committed lib/ differs from a clean rebuild of HEAD src" >&2
  sed -n '1,80p' "$TMP/lib.diff" >&2
  exit 1
fi
echo "  committed lib/ matches clean rebuild (zero diff)"

VERSION="$(node -p "require('$TMP/build/package.json').version")"
echo "  package version: $VERSION"

echo "-- pack audit --"
(cd "$TMP/build" && pnpm pack --pack-destination "$TMP/pack" >/dev/null)
TARBALL="$(ls "$TMP/pack"/*.tgz | head -1)"
tar -xzf "$TARBALL" -C "$TMP/unpack"

if rg -n --no-messages '/home/|/Users/|C:\\\\|/private/var/' "$TMP/unpack" \
  | rg -v 'docs/(demo|CHANGELOG|MANUAL-TEST|ROADMAP|FEATURES|PROTOCOL|PLAN|perf)' > "$TMP/paths.txt"; then
  echo "FAIL: packed artifacts contain machine absolute paths" >&2
  sed -n '1,40p' "$TMP/paths.txt" >&2
  exit 1
fi
echo "  packed tarball free of machine absolute paths"

TARBALL_HASH="$(sha256sum "$TARBALL" | awk '{print $1}')"
TREE_HASH="$(cd "$TMP/unpack" && find . -type f | sort | xargs sha256sum | sha256sum | awk '{print $1}')"
echo "  tarball: $TARBALL_HASH"
echo "  package tree: $TREE_HASH"

echo "verify-release-artifacts: PASSED"
