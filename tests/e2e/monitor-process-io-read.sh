#!/usr/bin/env bash
# Deterministic parser/threshold regression: a child reads a controlled 16MiB
# file after the first sample, so rchar must produce a positive window delta.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
RUN_DIR="$(mktemp -d "$TMP_ROOT/dsh-oc-monitor-read.XXXXXX")"
cleanup() {
  find "$RUN_DIR" -type f -delete 2>/dev/null || true
  find "$RUN_DIR" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

dd if=/dev/zero of="$RUN_DIR/input.bin" bs=1M count=16 status=none
set +e
"$ROOT/scripts/monitor-process-io.sh" \
  --start --terminate-owned --include-descendants \
  --interval 0.1 --samples 20 --rchar-threshold 65536 \
  --log "$RUN_DIR/io.tsv" \
  -- python3 -c 'import sys,time; time.sleep(0.2); f=open(sys.argv[1], "rb"); [time.sleep(0.001) for _ in iter(lambda: f.read(4096), b"")]; f.close()' "$RUN_DIR/input.bin" \
  2>"$RUN_DIR/warnings.log"
monitor_rc=$?
set -e

[[ "$monitor_rc" == 0 ]]
awk -F '\t' 'NR > 1 && $11 > 0 { found=1 } END { exit found ? 0 : 1 }' "$RUN_DIR/io.tsv"
grep -Eq 'rchar_delta=[1-9][0-9]*' "$RUN_DIR/warnings.log"
echo 'monitor-process-io-read: PASSED'
