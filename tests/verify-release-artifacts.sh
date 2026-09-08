#!/usr/bin/env bash
# Regression coverage for the release artifact machine-path scanner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-oc-artifact-scan-test.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

# Build a PATH which omits every directory that provides rg, while restoring
# only the commands needed by the release audit if rg happens to share a
# directory with them (for example, a runner image may put everything under
# /usr/bin).
NO_RG_BIN="$TMP/no-rg-bin"
mkdir -p "$NO_RG_BIN"
ORIGINAL_PATH="$PATH"
NO_RG_PATH=""
IFS=: read -r -a PATH_DIRS <<< "$ORIGINAL_PATH"
for dir in "${PATH_DIRS[@]}"; do
  [[ -n "$dir" && -x "$dir/rg" ]] && continue
  if [[ -n "$NO_RG_PATH" ]]; then NO_RG_PATH+=":"; fi
  NO_RG_PATH+="$dir"
done
for tool in bash pnpm node git tar sha256sum awk xargs find sed mktemp realpath \
  grep ls head tail cat sort diff dirname rm mkdir ln uname sh env which getconf ldd gzip; do
  if ! PATH="$NO_RG_PATH" command -v "$tool" >/dev/null 2>&1; then
    source="$(command -v "$tool" || true)"
    [[ -n "$source" ]] || { echo "missing test prerequisite: $tool" >&2; exit 2; }
    ln -s "$source" "$NO_RG_BIN/$tool"
  fi
done
NO_RG_PATH="$NO_RG_BIN:$NO_RG_PATH"
if PATH="$NO_RG_PATH" command -v rg >/dev/null 2>&1; then
  echo "test setup failed: rg is still visible in fallback PATH" >&2
  exit 2
fi

echo "== clean pack audit without rg =="
if ! PATH="$NO_RG_PATH" bash "$ROOT/scripts/verify-release-artifacts.sh" \
  > "$TMP/clean.log" 2>&1; then
  cat "$TMP/clean.log" >&2
  echo "clean artifact audit failed without rg" >&2
  exit 1
fi
grep -q 'path scanner: grep' "$TMP/clean.log"
grep -q 'verify-release-artifacts: PASSED' "$TMP/clean.log"

echo "== injected absolute path must fail scanner =="
mkdir -p "$TMP/injected/package"
printf '/home/injected-release-path\n' > "$TMP/injected/package/injected.txt"
set +e
PATH="$NO_RG_PATH" bash "$ROOT/scripts/scan-release-artifact-paths.sh" \
  "$TMP/injected" "$TMP/injected.paths" > "$TMP/injected.log" 2>&1
INJECTED_RC=$?
set -e
if [[ "$INJECTED_RC" != 1 ]]; then
  cat "$TMP/injected.log" >&2
  echo "injected path was not reported as a scanner match (rc=$INJECTED_RC)" >&2
  exit 1
fi
grep -q '/home/injected-release-path' "$TMP/injected.paths"

echo "== no scanner must fail =="
NO_SCANNER_BIN="$TMP/no-scanner-bin"
mkdir -p "$NO_SCANNER_BIN"
for tool in bash mktemp rm; do
  ln -s "$(command -v "$tool")" "$NO_SCANNER_BIN/$tool"
done
set +e
PATH="$NO_SCANNER_BIN" bash "$ROOT/scripts/scan-release-artifact-paths.sh" \
  "$TMP/injected" "$TMP/no-scanner.paths" > "$TMP/no-scanner.log" 2>&1
NO_SCANNER_RC=$?
set -e
if [[ "$NO_SCANNER_RC" != 2 ]]; then
  cat "$TMP/no-scanner.log" >&2
  echo "missing scanner did not fail closed (rc=$NO_SCANNER_RC)" >&2
  exit 1
fi
grep -q 'neither rg nor grep is available' "$TMP/no-scanner.log"

echo "== invalid TMPDIR must fail scanner setup =="
set +e
TMPDIR=/proc bash "$ROOT/scripts/scan-release-artifact-paths.sh" \
  "$TMP/injected" "$TMP/invalid-tmpdir.paths" > "$TMP/invalid-tmpdir.log" 2>&1
INVALID_TMPDIR_RC=$?
set -e
if [[ "$INVALID_TMPDIR_RC" != 2 ]]; then
  cat "$TMP/invalid-tmpdir.log" >&2
  echo "invalid TMPDIR did not fail closed (rc=$INVALID_TMPDIR_RC)" >&2
  exit 1
fi
grep -q 'path scanner setup failed' "$TMP/invalid-tmpdir.log"

echo "verify-release-artifacts regression: PASSED"
