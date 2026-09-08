#!/usr/bin/env bash
# Scan one extracted package tree for machine-specific absolute paths.
# Exit status is deliberately tri-state:
#   0 = clean, 1 = forbidden paths found, 2 = scanner/setup failure.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <root> <output-file>" >&2
  exit 2
fi

ROOT="$1"
OUTPUT="$2"
if [[ ! -d "$ROOT" ]]; then
  echo "path scanner: root is not a directory: $ROOT" >&2
  exit 2
fi
if ! : > "$OUTPUT"; then
  echo "path scanner: cannot write output: $OUTPUT" >&2
  exit 2
fi

RAW=""
ERRORS=""
cleanup() {
  [[ -z "$RAW" ]] || rm -f "$RAW"
  [[ -z "$ERRORS" ]] || rm -f "$ERRORS"
}
trap cleanup EXIT

if ! RAW="$(mktemp "${TMPDIR:-/tmp}/dsh-oc-path-scan.XXXXXX")"; then
  echo "path scanner setup failed: cannot create raw scan temporary file" >&2
  exit 2
fi
if ! ERRORS="$(mktemp "${TMPDIR:-/tmp}/dsh-oc-path-scan-errors.XXXXXX")"; then
  echo "path scanner setup failed: cannot create scanner-error temporary file" >&2
  exit 2
fi

PATTERN='/home/|/Users/|C:\\\\|/private/var/'
SCANNER=""
SCAN_RC=2
if command -v rg >/dev/null 2>&1; then
  SCANNER="rg"
  if rg -n "$PATTERN" "$ROOT" > "$RAW" 2> "$ERRORS"; then
    SCAN_RC=0
  else
    SCAN_RC=$?
  fi
elif command -v grep >/dev/null 2>&1; then
  SCANNER="grep"
  if grep -RInE --binary-files=without-match "$PATTERN" "$ROOT" > "$RAW" 2> "$ERRORS"; then
    SCAN_RC=0
  else
    SCAN_RC=$?
  fi
else
  echo "path scanner: neither rg nor grep is available" >&2
  exit 2
fi

echo "  path scanner: $SCANNER" >&2
if [[ "$SCAN_RC" != 0 && "$SCAN_RC" != 1 ]]; then
  echo "path scanner: $SCANNER failed (rc=$SCAN_RC)" >&2
  sed -n '1,20p' "$ERRORS" >&2 || true
  exit 2
fi

if ! command -v awk >/dev/null 2>&1; then
  echo "path scanner: awk is unavailable for the exclusion filter" >&2
  exit 2
fi

# Documentation fixtures intentionally contain illustrative paths. Keep this
# exclusion identical to the historical release audit while doing it in a
# status-safe filter instead of a second grep pipeline.
if ! awk '!/docs\/(demo|CHANGELOG|MANUAL-TEST|ROADMAP|FEATURES|PROTOCOL|PLAN|perf)/' \
  "$RAW" > "$OUTPUT"; then
  echo "path scanner: exclusion filter failed" >&2
  exit 2
fi

if [[ -s "$OUTPUT" ]]; then
  exit 1
fi
exit 0
