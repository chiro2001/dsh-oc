#!/usr/bin/env bash
# Exercise the optional e2e_tui_wait_attach observer without starting dsh/TUI.
# A controlled ps fixture supplies the current run's parent/child relation;
# the observed child itself is a real sleep process so monitor /proc reads are
# still exercised.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tests/e2e/common.sh"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-oc-attach-monitor.XXXXXX")"
FAKE_BIN="$RUN_DIR/bin"
ATTACH_PID_FILE="$RUN_DIR/attach.pid"
OVERLAY="$RUN_DIR/current-overlay.yml"
mkdir -p "$FAKE_BIN"
: > "$OVERLAY"

cleanup() {
  if [[ -n "${ATTACH_PID:-}" ]]; then
    kill "$ATTACH_PID" 2>/dev/null || true
    wait "$ATTACH_PID" 2>/dev/null || true
  fi
  e2e_tui_io_monitor_cleanup || true
  find "$RUN_DIR" -type f -delete 2>/dev/null || true
  find "$RUN_DIR" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
attach_pid="$(<"${FAKE_ATTACH_PID_FILE:?}")"
printf '424242 /usr/bin/dsh --profile oc --patch %s\n' "${FAKE_OVERLAY:?}"
printf '%s 424242 /home/test/opencode attach http://127.0.0.1:4567\n' "$attach_pid"
printf '525252 515151 /home/other/opencode attach http://127.0.0.1:9999\n'
EOF
chmod +x "$FAKE_BIN/ps"

export PATH="$FAKE_BIN:$PATH"
export FAKE_ATTACH_PID_FILE="$ATTACH_PID_FILE"
export FAKE_OVERLAY="$OVERLAY"
export DSH_OC_E2E_MONITOR_IO=1
export DSH_OC_E2E_MONITOR_INTERVAL=0.05
export DSH_OC_E2E_MONITOR_READ_THRESHOLD=33554432
E2E_RUN_DIR="$RUN_DIR"
E2E_OVERLAY="$OVERLAY"
E2E_TUI_SESSION='attach-monitor-test'

run_one() {
  sleep 60 &
  ATTACH_PID=$!
  printf '%s\n' "$ATTACH_PID" > "$ATTACH_PID_FILE"

  e2e_tui_wait_attach
  local monitor_pid="$E2E_TUI_IO_MONITOR_PID"
  local log_file="$E2E_TUI_IO_MONITOR_LOG"
  local warning_file="$E2E_TUI_IO_MONITOR_WARN"
  [[ "$E2E_TUI_ATTACH_PID" == "$ATTACH_PID" ]]
  [[ "$monitor_pid" != "$ATTACH_PID" ]]
  for _ in $(seq 1 40); do
    [[ -s "$log_file" ]] && break
    sleep 0.05
  done
  [[ -s "$log_file" ]]
  kill -0 "$ATTACH_PID" 2>/dev/null

  # The observer must not terminate its target. End the target explicitly;
  # monitor-process-io should then leave observe-only mode by itself.
  kill "$ATTACH_PID"
  wait "$ATTACH_PID" 2>/dev/null || true
  ATTACH_PID=""
  e2e_tui_io_monitor_cleanup
  [[ -f "$warning_file" ]]
  [[ ! -s "$warning_file" ]]
}

run_one
first_log="$E2E_TUI_IO_MONITOR_LOG"
run_one
second_log="$E2E_TUI_IO_MONITOR_LOG"

[[ "$first_log" != "$second_log" ]]
[[ "$(find "$RUN_DIR" -name '*.io.tsv' -type f | wc -l)" -eq 2 ]]
[[ "$(find "$RUN_DIR" -name '*.io.warn' -type f | wc -l)" -eq 2 ]]

# `--report-exit` is an explicit diagnostic opt-in; the default observer above
# must stay quiet when its external target exits normally.
sleep 1 &
report_target=$!
report_log="$RUN_DIR/report.tsv"
report_warn="$RUN_DIR/report.warn"
"$ROOT/scripts/monitor-process-io.sh" --pid "$report_target" --interval 0.05 \
  --report-exit --log "$report_log" 2>"$report_warn" &
report_monitor=$!
wait "$report_target"
wait "$report_monitor"
grep -q 'observed PID' "$report_warn"
echo 'monitor-process-io-attach: PASSED'
