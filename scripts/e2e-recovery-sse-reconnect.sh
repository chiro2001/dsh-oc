#!/usr/bin/env bash
# Client SSE reconnect e2e: while a slow streaming turn is in flight, an
# observer SSE connection is killed mid-stream and re-established. Asserts
# the final v1/v2 message graphs are exactly-once and complete, and that the
# reconnected observer keeps receiving events through turn completion.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh
source tests/e2e/recovery-lib.sh

SCRIPT_START=$SECONDS
E2E_RUNID=""
SSE1_PID=""
SSE2_PID=""

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$SSE1_PID" ]]; then kill "$SSE1_PID" 2>/dev/null || true; fi
  if [[ -n "$SSE2_PID" ]]; then kill "$SSE2_PID" 2>/dev/null || true; fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

export DSH_OC_E2E_CHUNK_DELAY_MS=150
export DSH_OC_E2E_CHUNK_SIZE=1
e2e_new_run "recovery-sse-reconnect" "danger-full-access" "slow_success" "1"

echo "== boot TUI and start a slow stream =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'sse reconnect me' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

echo "== observer SSE connection #1 =="
curl -sN --max-time 120 "$E2E_BRIDGE_URL/api/session/$SID/event" \
  > "$E2E_RUN_DIR/sse1.log" 2>/dev/null &
SSE1_PID=$!
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  if grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/sse1.log"; then
    break
  fi
  sleep 1
done
if ! grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/sse1.log"; then
  echo "e2e: observer SSE #1 did not see stream start" >&2
  tail -20 "$E2E_RUN_DIR/sse1.log" >&2 || true
  exit 1
fi
echo "  stream delta observed on SSE #1"

# Kill the observer mid-stream, wait through a disconnect gap, reconnect.
kill "$SSE1_PID" 2>/dev/null || true
SSE1_PID=""
sleep 1
echo "== observer SSE connection #2 (reconnect) =="
curl -sN --max-time 120 "$E2E_BRIDGE_URL/api/session/$SID/event" \
  > "$E2E_RUN_DIR/sse2.log" 2>/dev/null &
SSE2_PID=$!

# The reconnected observer must keep receiving events; wait for either a
# further delta or the assistant completion update.
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/sse2.log" \
    || grep -qa '"type":"message.updated"' "$E2E_RUN_DIR/sse2.log"; then
    break
  fi
  sleep 1
done
if ! grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/sse2.log" \
  && ! grep -qa '"type":"message.updated"' "$E2E_RUN_DIR/sse2.log"; then
  echo "e2e: reconnected SSE #2 did not receive events" >&2
  tail -20 "$E2E_RUN_DIR/sse2.log" >&2 || true
  exit 1
fi
echo "  reconnected SSE #2 receiving events"

recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
kill "$SSE2_PID" 2>/dev/null || true
SSE2_PID=""

echo "== final exactly-once checks =="
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/final-v1.json" "$E2E_RUN_DIR/final-v2.json"

if ! curl -s "$E2E_BRIDGE_URL/api/session/$SID/message" | jq -e '
    ([.data[].id] | length) == ([.data[].id] | unique | length)
    and ([.data[] | select(.type == "user" and .text == "sse reconnect me")] | length) == 1
    and ([.data[] | select(.type == "assistant") | .content[]?
          | select(.type == "text" and (.text | length) > 0)] | length) == 1
  ' >/dev/null; then
  echo "e2e: final graph not exactly-once after SSE reconnect" >&2
  cat "$E2E_RUN_DIR/final-v2.json" >&2
  exit 1
fi
echo "  final graph exactly-once after client SSE reconnect"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-recovery-sse-reconnect: PASSED in $((SECONDS - SCRIPT_START))s"
