#!/usr/bin/env bash
# Attach --print-logs e2e: the flag is forwarded verbatim to the opencode
# child (verified through the fake wrapper argv) and is absent without it.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

start_fake_dsh() {
  local extra="$1"
  local log="$2"
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$E2E_TUI_SESSION" -x 200 -y 50
  local cmd
  cmd="cd '$E2E_WORKDIR' && export DSH_HOME='$E2E_DSH_HOME' DSH_PERMISSION_MODE='$E2E_PERMISSION_MODE' DSH_OC_E2E_MOCK_API_KEY='$E2E_API_KEY' DSH_OC_OPENCODE_BIN='$E2E_FAKE_BIN' DSH_OC_FAKE_LOG='$log' && dsh --profile oc --patch '$E2E_OVERLAY' $extra"
  tmux send-keys -t "$E2E_TUI_SESSION" "$cmd" Enter
}

echo "== --print-logs forwarded to the opencode child =="
e2e_new_run "tui-print-logs-on" "danger-full-access" "success" "1"
E2E_ACTIVE_SESSION="dsh-oc-print-logs-on"
LOG_ON="$E2E_RUN_DIR/fake-on.log"
start_fake_dsh "--print-logs" "$LOG_ON"
E2E_FAKE_LOG="$LOG_ON"
e2e_wait_bridge_url
grep -q -- "--print-logs" "$LOG_ON"
echo "  child argv contains --print-logs"
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "== without the flag it stays absent =="
e2e_new_run "tui-print-logs-off" "danger-full-access" "success" "1"
E2E_ACTIVE_SESSION="dsh-oc-print-logs-off"
LOG_OFF="$E2E_RUN_DIR/fake-off.log"
start_fake_dsh "" "$LOG_OFF"
E2E_FAKE_LOG="$LOG_OFF"
e2e_wait_bridge_url
if grep -q -- "--print-logs" "$LOG_OFF"; then
  echo "e2e: --print-logs leaked without the flag" >&2
  exit 1
fi
echo "  child argv clean without --print-logs"
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "== --log-level value forwarded to the opencode child =="
e2e_new_run "tui-log-level" "danger-full-access" "success" "1"
E2E_ACTIVE_SESSION="dsh-oc-log-level"
LOG_LEVEL="$E2E_RUN_DIR/fake-level.log"
start_fake_dsh "--log-level debug" "$LOG_LEVEL"
E2E_FAKE_LOG="$LOG_LEVEL"
e2e_wait_bridge_url
grep -q -- "--log-level" "$LOG_LEVEL"
grep -q -- "debug" "$LOG_LEVEL"
echo "  child argv contains --log-level debug"
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-print-logs: PASSED in $((SECONDS - SCRIPT_START))s"
