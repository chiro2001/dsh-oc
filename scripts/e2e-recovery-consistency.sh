#!/usr/bin/env bash
# Recovery-consistency e2e: build a live session (tool call + text turn),
# snapshot the normalized v2 message graph, then re-attach with --session in
# a fresh dsh process and compare. Asserts exactly-once recovery: same
# message count, same role sequence, same part types/texts and the same
# parent structure (ids may differ between bridge and dsh namespaces).
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

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

wait_tui_ready() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
    if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt" \
      || grep -qa 'ctrl+p commands' "$E2E_RUN_DIR/tui-ready.txt"; then
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited while waiting for TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
      return 1
    fi
    sleep 1
  done
  return 1
}

wait_text() {
  local url="$1"
  local want="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$url" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$text" == *"$want"* ]]; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: reply text not seen for $url (want $want)" >&2
  curl -s "$url" >&2 || true
  return 1
}

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

signature() {
  local bridge="$1"
  local sid="$2"
  local out="$3"
  curl -s "$bridge/api/session/$sid/message" | jq -c '
    . as $all |
    [ $all.data[] as $msg |
      {
        type: $msg.type,
        parent: (if $msg.parentID == null then null else
          ([$all.data | to_entries[] | select(.value.id == $msg.parentID) | .key][0] // null) end),
        parts: [$msg.content[]? | {type, text: (.text // .state.output // .state.input // null)}]
      }
    ]
  ' > "$out"
}

export DSH_OC_E2E_CHUNK_DELAY_MS=30
export DSH_OC_E2E_CHUNK_SIZE=10
e2e_new_run "recovery-consistency" "danger-full-access" \
  "tool_call_success,success,success,success" "1" \
  '{"command":"echo rec-ok","description":"tool","sandbox_permissions":"danger-full-access","justification":"e2e"}'

echo "== live session with a tool call and a text turn =="
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
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
wait_text "$E2E_BRIDGE_URL/session/$SID/message" "e2e recovery tool prompt"
tmux send-keys -t "$E2E_TUI_SESSION" 'e2e recovery text prompt' Enter
wait_text "$E2E_BRIDGE_URL/session/$SID/message" "e2e recovery text prompt"
sleep 3
signature "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/live.json"
echo "  live signature saved"

echo "== re-attach with --session in a fresh dsh process =="
e2e_tui_exit
rm -f "$E2E_RUN_DIR/dsh-exit.txt"
e2e_tui_start "--session $SID"
e2e_tui_wait_attach
wait_tui_ready
signature "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/reattach.json"

if ! jq -e -n \
  --slurpfile live "$E2E_RUN_DIR/live.json" \
  --slurpfile re "$E2E_RUN_DIR/reattach.json" '
    ($live[0] | length) == ($re[0] | length)
    and ([$live[0][].type] == [$re[0][].type])
    and ([$live[0][].parent] == [$re[0][].parent])
    and ([$live[0][].parts[].type] == [$re[0][].parts[].type])
    and ([$live[0][].parts[].text] == [$re[0][].parts[].text])
  '; then
  echo "e2e: live and re-attach message graphs differ" >&2
  echo "--- live ---" >&2
  cat "$E2E_RUN_DIR/live.json" >&2
  echo "--- reattach ---" >&2
  cat "$E2E_RUN_DIR/reattach.json" >&2
  exit 1
fi
echo "  recovery consistent: same messages, roles, parents and parts"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-recovery-consistency: PASSED in $((SECONDS - SCRIPT_START))s"
