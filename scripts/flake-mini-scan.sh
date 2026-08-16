#!/usr/bin/env bash
# Budgeted flake scan (round-0002 experiment 3): repeat minimal high-risk
# e2e scripts N times (default 10) and record first-attempt pass/fail and
# duration. A semantic failure stops the scan immediately and keeps the
# first failure log; there is no in-scan retry.
#
# Usage:
#   bash scripts/flake-mini-scan.sh [--runs 10] \
#     [--scripts "e2e-recovery-consistency.sh e2e-recovery-crash.sh ..."] \
#     [--timeout 300]
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS=10
SCRIPTS="e2e-recovery-consistency.sh e2e-recovery-crash.sh e2e-recovery-sse-reconnect.sh"
TIMEOUT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="${2:-10}"; shift 2 ;;
    --scripts) SCRIPTS="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-300}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$SCRIPTS" ]]; then
  echo "flake-mini-scan: --scripts must not be empty" >&2
  exit 2
fi

OUT_DIR="${FLAKE_SCAN_DIR:-/tmp/flake-mini-scan}"
mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.json"
START_EPOCH="$(date +%s)"
FAILED=0

echo "flake-mini-scan: ${RUNS} runs x [${SCRIPTS}]"
echo "flake-mini-scan: output $OUT_DIR"

results=()
for script in $SCRIPTS; do
  passes=0
  durations=()
  failures=0
  for (( n = 1; n <= RUNS; n++ )); do
    log="$OUT_DIR/${script%.sh}-${n}.log"
    t0="$SECONDS"
    set +e
    timeout -k 15 "$TIMEOUT" bash "scripts/$script" > "$log" 2>&1
    rc=$?
    set -e
    elapsed=$((SECONDS - t0))
    durations+=("$elapsed")
    if [[ "$rc" == "0" && "$(tail -1 "$log")" == *PASSED* ]]; then
      passes=$((passes + 1))
      echo "  PASS $script run $n (${elapsed}s)"
    else
      failures=$((failures + 1))
      echo "  FAIL $script run $n (rc=$rc, ${elapsed}s) -- first failure log: $log" >&2
      tail -40 "$log" >&2 || true
      FAILED=1
      break
    fi
  done
  results+=("{\"script\":\"$script\",\"runs\":$((passes + failures)),\"passes\":$passes,\"failures\":$failures,\"durations\":[$(IFS=,; echo "${durations[*]}")]}")
  if [[ "$FAILED" == "1" ]]; then
    break
  fi
done

jq -n \
  --argjson results "[$(IFS=,; echo "${results[*]}")]" \
  --arg started "$(date -d @"$START_EPOCH" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')" \
  '{ started: $started, results: $results }' > "$SUMMARY"
echo "flake-mini-scan: summary $SUMMARY"
cat "$SUMMARY"

if [[ "$FAILED" == "1" ]]; then
  echo "flake-mini-scan: FAILED (semantic failure found; fix before widening runs)" >&2
  exit 1
fi
echo "flake-mini-scan: PASSED"
