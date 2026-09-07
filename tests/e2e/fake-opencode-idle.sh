#!/usr/bin/env bash
# Prove the fake attach binary blocks while idle instead of spinning on EOF.
# This test starts its own process group through monitor-process-io.sh; the
# monitor is explicitly allowed to terminate that owned group after sampling.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
RUN_DIR="$(mktemp -d "$TMP_ROOT/dsh-oc-fake-idle.XXXXXX")"
cleanup() {
  find "$RUN_DIR" -type f -delete 2>/dev/null || true
  find "$RUN_DIR" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

DSH_OC_FAKE_LOG="$RUN_DIR/fake.log" \
  "$ROOT/scripts/monitor-process-io.sh" \
  --start --terminate-owned --include-descendants \
  --interval 0.1 --samples 6 --log "$RUN_DIR/io.tsv" -- \
  "$ROOT/tests/e2e/fake-opencode.sh" attach http://127.0.0.1:1

grep -q '^attach$' "$RUN_DIR/fake.log"
awk -F '\t' '
  NR == 1 { next }
  NR == 2 { next }
  {
    if ($9 > 4096 || $10 > 4096 || $11 > 4096 || $12 > 4096 || $13 > 1) exit 1
  }
' "$RUN_DIR/io.tsv"

echo 'fake-opencode-idle: PASSED'
