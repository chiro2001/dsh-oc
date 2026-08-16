#!/usr/bin/env bash
# Process-crash recovery e2e: SIGKILL dsh in the middle of a slow streaming
# turn, restart with --session in a fresh dsh process, then assert:
#  1. the restart graph is exactly the persisted prefix (no loss, no fake
#     completion, no duplicates);
#  2. the session reaches a usable terminal state (idle, or idle after
#     explicitly cancelling the stale in-flight turn);
#  3. a new prompt is accepted and completes, and the final graph starts with
#     the restart graph plus exactly one user + one assistant turn.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh
source tests/e2e/recovery-lib.sh

SCRIPT_START=$SECONDS
E2E_RUNID=""

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

export DSH_OC_E2E_CHUNK_DELAY_MS=150
export DSH_OC_E2E_CHUNK_SIZE=1
e2e_new_run "recovery-crash" "danger-full-access" "slow_success" "1"

echo "== boot TUI and start a slow stream =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'crash me mid-stream' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

# Wait until the v2 projection shows a partial assistant text: the stream
# started and at least one chunk is durable.
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if curl -s "$E2E_BRIDGE_URL/api/session/$SID/message" | jq -e '
      [.data[] | select(.type == "assistant")
        | .content[]? | select(.type == "text" and (.text | length) > 0)] | length > 0
    ' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if (( SECONDS >= deadline )); then
  echo "e2e: stream did not produce durable text before crash" >&2
  exit 1
fi
echo "  stream started (partial text durable)"

recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/pre-crash-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/pre-crash-v1.json"
echo "  pre-crash signature saved"

DSH_PID="$(ps -eo pid=,args= | awk -v overlay="$E2E_OVERLAY" '$0 ~ overlay && $0 ~ /dsh --profile/ { print $1; exit }')"
if [[ -z "$DSH_PID" ]]; then
  echo "e2e: cannot locate dsh process for crash" >&2
  exit 1
fi
echo "  SIGKILL dsh $DSH_PID"
kill -9 "$DSH_PID"
# The opencode attach child becomes an orphan; kill it too so repeated
# crash runs do not accumulate stray TUI processes.
ATTACH_PIDS="$(ps -eo ppid=,pid=,args= | awk -v pid="$DSH_PID" '$1 == pid && $0 ~ /opencode attach http:\/\/127\.0\.0\.1:/ { print $2 }')"
if [[ -n "$ATTACH_PIDS" ]]; then
  kill -9 $ATTACH_PIDS 2>/dev/null || true
fi
deadline=$((SECONDS + 15))
while (( SECONDS < deadline )); do
  if ! ps -p "$DSH_PID" >/dev/null 2>&1; then break; fi
  sleep 1
done
tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true

echo "== restart with --session =="
rm -f "$E2E_RUN_DIR/dsh-exit.txt"
e2e_tui_start "--session $SID"
e2e_tui_wait_attach
recovery_wait_tui_ready
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/restart-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/restart-v1.json"
recovery_assert_crash_prefix "v2 restart" "$E2E_RUN_DIR/restart-v2.json" "$E2E_RUN_DIR/pre-crash-v2.json"
recovery_assert_crash_prefix "v1 restart" "$E2E_RUN_DIR/restart-v1.json" "$E2E_RUN_DIR/pre-crash-v1.json"
echo "  restart graph is a prefix of the last observed projection"

# The session must reach idle. dsh may restore the in-flight turn as running;
# explicitly cancel it if so, then verify the terminal state.
if ! recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"; then
  echo "  session busy after crash; cancelling stale turn"
  curl -s -o /dev/null -w '  interrupt=%{http_code}\n' \
    -X POST "$E2E_BRIDGE_URL/api/session/$SID/interrupt"
  recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
fi
echo "  session idle after crash restart"

echo "== continue with a new prompt =="
curl -s -X POST "$E2E_BRIDGE_URL/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"continue after crash"}]}' >/dev/null
recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/final-v1.json" "$E2E_RUN_DIR/final-v2.json"
recovery_assert_prefix "v2 final" "$E2E_RUN_DIR/restart-v2.json" "$E2E_RUN_DIR/final-v2.json"
recovery_assert_prefix "v1 final" "$E2E_RUN_DIR/restart-v1.json" "$E2E_RUN_DIR/final-v1.json"

# No duplicate message ids and exactly one occurrence of each user text.
if ! curl -s "$E2E_BRIDGE_URL/api/session/$SID/message" | jq -e '
    ([.data[].id] | length) == ([.data[].id] | unique | length)
    and ([.data[] | select(.type == "user" and .text == "continue after crash")] | length) == 1
    and ([.data[] | select(.type == "assistant") | .content[]?
          | select(.type == "text" and (.text | length) > 0)] | length) >= 2
  ' >/dev/null; then
  echo "e2e: final graph has duplicates or missing turns after crash recovery" >&2
  cat "$E2E_RUN_DIR/final-v2.json" >&2
  exit 1
fi
echo "  final graph exactly-once and continues after crash"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-recovery-crash: PASSED in $((SECONDS - SCRIPT_START))s"
