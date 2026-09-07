#!/usr/bin/env bash
# Safety regressions for monitor-process-io owned process groups. No dsh,
# opencode, or TUI is involved; every process here is started by this script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
RUN_DIR="$(mktemp -d "$TMP_ROOT/dsh-oc-monitor-owned.XXXXXX")"
cleanup() {
  find "$RUN_DIR" -type f -delete 2>/dev/null || true
  find "$RUN_DIR" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

assert_gone() {
  local pid_file=$1 pid
  pid="$(<"$pid_file")"
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    sleep 0.05
  done
  echo "monitor-process-io-owned: process $pid survived owned cleanup" >&2
  return 1
}

# A child ignores TERM, so cleanup must wait and then KILL the verified group.
term_marker="$RUN_DIR/term-child.pid"
"$ROOT/scripts/monitor-process-io.sh" --start --terminate-owned --samples 2 --interval 0.1 \
  --log "$RUN_DIR/term.tsv" -- bash -c 'trap "" TERM; sleep 30 & child=$!; echo "$child" > "$1"; wait' bash "$term_marker"
assert_gone "$term_marker"

# The root exits while a child remains in the same verified SID/PGID. The
# monitor must continue tracking the child and clean it at the sample limit.
early_marker="$RUN_DIR/early-child.pid"
"$ROOT/scripts/monitor-process-io.sh" --start --terminate-owned --samples 5 --interval 0.1 \
  --log "$RUN_DIR/early.tsv" -- bash -c 'trap "" TERM; sleep 30 & child=$!; echo "$child" > "$1"; sleep 0.2; exit 0' bash "$early_marker"
assert_gone "$early_marker"

# An externally supplied PID can never opt into termination.
if "$ROOT/scripts/monitor-process-io.sh" --pid "$$" --terminate-owned --samples 1 --log "$RUN_DIR/external.tsv" 2>/dev/null; then
  echo 'monitor-process-io-owned: external terminate guard failed' >&2
  exit 1
fi

echo 'monitor-process-io-owned: PASSED'
