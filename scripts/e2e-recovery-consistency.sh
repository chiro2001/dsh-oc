#!/usr/bin/env bash
# Recovery-consistency e2e: build a live session (tool call + text turn),
# snapshot the normalized v2 message graph, then re-attach with --session in
# a fresh dsh process and compare. Asserts exactly-once recovery: same
# message count, same role sequence, same part types/texts and the same
# parent structure (ids may differ between bridge and dsh namespaces).
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

wait_tool() {
  local url="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -s "$url" | jq -e '[.data[]? | select(.type == "assistant") | .content[]? | select(.type == "tool")] | length > 0' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: tool part not seen for $url" >&2
  return 1
}

export DSH_OC_E2E_CHUNK_DELAY_MS=30
export DSH_OC_E2E_CHUNK_SIZE=10
e2e_new_run "recovery-consistency" "danger-full-access" \
  "tool_call_success,success,success,success" "1" \
  '{"command":"echo rec-ok","description":"tool","sandbox_permissions":"danger-full-access","justification":"e2e"}'

echo "== live session with a tool call and a text turn =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'e2e recovery tool prompt' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_tool "$E2E_BRIDGE_URL/api/session/$SID/message"
recovery_wait_text "$E2E_BRIDGE_URL/session/$SID/message" "e2e recovery tool prompt"
tmux send-keys -t "$E2E_TUI_SESSION" 'e2e recovery text prompt' Enter
recovery_wait_text "$E2E_BRIDGE_URL/session/$SID/message" "e2e recovery text prompt"
recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/live-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/live-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/live-v1.json" "$E2E_RUN_DIR/live-v2.json"
echo "  live signatures saved"

echo "== re-attach with --session in a fresh dsh process =="
e2e_tui_exit
rm -f "$E2E_RUN_DIR/dsh-exit.txt"
e2e_tui_start "--session $SID"
e2e_tui_wait_attach
recovery_wait_tui_ready
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/reattach-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/reattach-v1.json"

recovery_compare_graphs "v2" "$E2E_RUN_DIR/live-v2.json" "$E2E_RUN_DIR/reattach-v2.json"
recovery_compare_graphs "v1" "$E2E_RUN_DIR/live-v1.json" "$E2E_RUN_DIR/reattach-v1.json"
echo "  recovery consistent: v1+v2 messages, roles, parents and parts"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-recovery-consistency: PASSED in $((SECONDS - SCRIPT_START))s"
