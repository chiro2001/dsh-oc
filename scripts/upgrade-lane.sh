#!/usr/bin/env bash
# Candidate opencode upgrade lane (LOCAL, manual): runs the golden scenario
# against a candidate opencode binary and semantically diffs the normalized
# bridge SSE trace against the committed 1.18.18 baseline. The version check
# is bypassed for the candidate (DSH_OC_BYPASS_VERSION_CHECK=1) so its wire
# behavior can be evaluated without touching opencode-version.json.
#
# Usage:
#   bash scripts/upgrade-lane.sh [--bin /path/to/opencode-candidate] \
#     [--out /tmp/dsh-oc-upgrade-lane]
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${DSH_OC_OPENCODE_BIN:-}"
OUT_DIR="${DSH_OC_LANE_OUT:-/tmp/dsh-oc-upgrade-lane}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin) BIN="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$BIN" ]]; then
  BIN="$(command -v opencode || true)"
fi
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  echo "upgrade-lane: candidate binary not found (--bin or DSH_OC_OPENCODE_BIN)" >&2
  exit 2
fi
BIN="$(realpath "$BIN")"
mkdir -p "$OUT_DIR"

BASELINE="$PWD/tests/fixtures/golden/recovery-tool-followup-1.18.18.sse.jsonl"
CANDIDATE_TRACE="$OUT_DIR/recovery-tool-followup.sse.jsonl"

echo "== upgrade lane: candidate $(basename "$BIN") =="
echo "-- candidate version --"
"$BIN" --version 2>&1 | head -2 || true

echo "-- run golden scenario against candidate (version check bypassed) --"
DSH_OC_OPENCODE_BIN="$BIN" \
  DSH_OC_GOLDEN_OUT="$CANDIDATE_TRACE" \
  bash scripts/e2e-golden-trace.sh

echo "-- semantic diff vs 1.18.18 baseline --"
if diff -q "$BASELINE" "$CANDIDATE_TRACE" >/dev/null; then
  echo "upgrade-lane: PASSED (zero semantic diff)"
  echo "  candidate trace: $CANDIDATE_TRACE"
  exit 0
fi

diff -u "$BASELINE" "$CANDIDATE_TRACE" > "$OUT_DIR/diff.txt" || true
echo "upgrade-lane: candidate trace differs from baseline" >&2
echo "  diff: $OUT_DIR/diff.txt" >&2
echo "  candidate trace: $CANDIDATE_TRACE" >&2
sed -n '1,60p' "$OUT_DIR/diff.txt" >&2 || true
exit 1
