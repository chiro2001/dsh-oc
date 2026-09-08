#!/usr/bin/env bash
# Offline fixture regression for update-local-install.sh lockfile resolution.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-oc-local-install-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

EXPECTED='b456c13f553a09a9b59488d02a338edd04bbcd9d'
DCP='5c6083dfd22520bca96ba21e7fcac3cf8dc97af0'

cat > "$TMP/mixed.yaml" <<EOF
dependencies:
  dcp: https://codeload.github.com/chiro2001/dsh-dcp/tar.gz/$DCP
  dshOc: https://codeload.github.com/chiro2001/dsh-oc/tar.gz/$EXPECTED
  dshOcDuplicate: https://codeload.github.com/chiro2001/dsh-oc/tar.gz/$EXPECTED
EOF
[[ "$(bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/mixed.yaml")" == "$EXPECTED" ]]
GREP_ONLY_BIN="$TMP/grep-only-bin"
mkdir -p "$GREP_ONLY_BIN"
for required_tool in bash dirname grep sed awk sort; do
  ln -s "$(command -v "$required_tool")" "$GREP_ONLY_BIN/$required_tool"
done
if PATH="$GREP_ONLY_BIN" command -v rg >/dev/null 2>&1; then
  echo 'grep-only fixture unexpectedly exposes rg' >&2
  exit 1
fi
fallback_commit="$(PATH="$GREP_ONLY_BIN" bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/mixed.yaml")"
[[ "$fallback_commit" == "$EXPECTED" ]]
[[ "$(bash "$ROOT/scripts/update-local-install.sh" --assert-resolved "$EXPECTED" "$TMP/mixed.yaml")" == "$EXPECTED" ]]

if bash "$ROOT/scripts/update-local-install.sh" --assert-resolved "$DCP" "$TMP/mixed.yaml" > "$TMP/wrong.out" 2> "$TMP/wrong.err"; then
  echo 'local install resolver accepted a mismatched full-SHA expectation' >&2
  exit 1
fi
grep -q 'expected ' "$TMP/wrong.err"

if bash "$ROOT/scripts/update-local-install.sh" --resolve-lock > "$TMP/args.out" 2> "$TMP/args.err"; then
  echo 'local install resolver accepted missing --resolve-lock argument' >&2
  exit 1
fi
grep -q 'usage: update-local-install.sh --resolve-lock' "$TMP/args.err"

if bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/missing-lock.yaml" > "$TMP/no-lock.out" 2> "$TMP/no-lock.err"; then
  echo 'local install resolver accepted a missing lockfile' >&2
  exit 1
fi
grep -q 'lockfile not found' "$TMP/no-lock.err"

FAKE_RG_BIN="$TMP/fake-rg-bin"
mkdir -p "$FAKE_RG_BIN"
printf '#!/usr/bin/env bash\necho fake scanner failure >&2\nexit 2\n' > "$FAKE_RG_BIN/rg"
chmod +x "$FAKE_RG_BIN/rg"
if PATH="$FAKE_RG_BIN:/usr/bin:/bin" bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/mixed.yaml" > "$TMP/scanner.out" 2> "$TMP/scanner.err"; then
  echo 'local install resolver ignored an rg scanner failure' >&2
  exit 1
fi
grep -q 'rg failed (rc=2)' "$TMP/scanner.err"

cat > "$TMP/missing.yaml" <<EOF
dependencies:
  dcp: https://codeload.github.com/chiro2001/dsh-dcp/tar.gz/$DCP
EOF
if bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/missing.yaml" > "$TMP/missing.out" 2> "$TMP/missing.err"; then
  echo 'local install resolver accepted a lockfile without dsh-oc' >&2
  exit 1
fi
grep -q 'no dsh-oc codeload commit' "$TMP/missing.err"

cat > "$TMP/ambiguous.yaml" <<EOF
dependencies:
  dshOcOld: https://codeload.github.com/chiro2001/dsh-oc/tar.gz/$DCP
  dshOcNew: https://codeload.github.com/chiro2001/dsh-oc/tar.gz/$EXPECTED
EOF
if bash "$ROOT/scripts/update-local-install.sh" --resolve-lock "$TMP/ambiguous.yaml" > "$TMP/ambiguous.out" 2> "$TMP/ambiguous.err"; then
  echo 'local install resolver accepted ambiguous dsh-oc commits' >&2
  exit 1
fi
grep -q 'ambiguous dsh-oc codeload commits' "$TMP/ambiguous.err"

echo 'update-local-install resolver regression: PASSED'
