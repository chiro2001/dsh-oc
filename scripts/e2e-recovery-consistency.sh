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

signature_v2() {
  local bridge="$1"
  local sid="$2"
  local out="$3"
  curl -s "$bridge/api/session/$sid/message" | jq -c '
    def norm_part:
      if .type == "tool" then
        { type, name: (.name // ""), status: .state.status,
          text: ((.state.content // []) | map(.text // "") | join("")) }
      else
        { type, text: (.text // "") }
      end;
    [ .data[] as $msg |
      {
        type: $msg.type,
        parts: (if $msg.type == "user" then [{ type: "text", text: ($msg.text // "") }]
                else [$msg.content[]? | norm_part] end)
      }
    ]
  ' > "$out"
}

# v1 history carries the parent chain the official TUI consumes. Normalize
# parent ids to relative indexes so warm (remapped surface ids) and cold
# (raw dsh ids) graphs are comparable, and keep per-message parts intact.
signature_v1() {
  local bridge="$1"
  local sid="$2"
  local out="$3"
  curl -s "$bridge/session/$sid/message" | jq -c '
    def norm_part:
      if .type == "tool" then
        { type, name: (.tool // ""), status: .state.status,
          text: (.state.output // .state.error // "") }
      else
        { type, text: (.text // "") }
      end;
    . as $all |
    [ $all[] as $msg |
      {
        role: $msg.info.role,
        parent: (if $msg.info.parentID == null then null else
          ([ $all | to_entries[] | select(.value.info.id == $msg.info.parentID) | .key ][0] // null) end),
        parts: [$msg.parts[]? | norm_part]
      }
    ]
  ' > "$out"
}

# Wait for the authoritative idle state instead of a fixed sleep, so the
# snapshot cannot be taken on an incomplete prefix.
wait_idle() {
  local bridge="$1"
  local sid="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$bridge/api/session/$sid/wait")"
    if [[ "$code" == "204" ]]; then
      return 0
    fi
    if [[ "$code" != "503" ]]; then
      echo "e2e: session wait returned $code" >&2
      return 1
    fi
    sleep 1
  done
  echo "e2e: session did not become idle in time" >&2
  return 1
}

# Sanity guards against empty assertions: at least one completed tool part
# with output, and every assistant parent must resolve to an index.
assert_graph_sane() {
  local v1="$1"
  local v2="$2"
  if ! jq -e '
    ([ .[] | select(.parts[]?.type == "tool")
        | select(.parts[] | (.status == "completed" and (.text | length) > 0)) ] | length) > 0
  ' "$v2" >/dev/null; then
    echo "e2e: no completed tool part with output in v2 graph" >&2
    cat "$v2" >&2
    return 1
  fi
  if ! jq -e '
    all(.[]; .role != "assistant" or .parent != null)
  ' "$v1" >/dev/null; then
    echo "e2e: v1 graph has dangling assistant parent" >&2
    cat "$v1" >&2
    return 1
  fi
  return 0
}

compare_graphs() {
  local label="$1"
  local live="$2"
  local re="$3"
  if ! jq -e -n \
    --slurpfile a "$live" \
    --slurpfile b "$re" '
      ($a[0] | length) == ($b[0] | length)
      and ([$a[0][].type] == [$b[0][].type])
      and ([$a[0][].parent] == [$b[0][].parent])
      and ([$a[0][].parts] == [$b[0][].parts])
    ' >/dev/null; then
    echo "e2e: $label graphs differ" >&2
    echo "--- live ---" >&2
    cat "$live" >&2
    echo "--- reattach ---" >&2
    cat "$re" >&2
    return 1
  fi
  return 0
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
wait_idle "$E2E_BRIDGE_URL" "$SID"
signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/live-v2.json"
signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/live-v1.json"
assert_graph_sane "$E2E_RUN_DIR/live-v1.json" "$E2E_RUN_DIR/live-v2.json"
echo "  live signatures saved"

echo "== re-attach with --session in a fresh dsh process =="
e2e_tui_exit
rm -f "$E2E_RUN_DIR/dsh-exit.txt"
e2e_tui_start "--session $SID"
e2e_tui_wait_attach
wait_tui_ready
signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/reattach-v2.json"
signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/reattach-v1.json"

compare_graphs "v2" "$E2E_RUN_DIR/live-v2.json" "$E2E_RUN_DIR/reattach-v2.json"
compare_graphs "v1" "$E2E_RUN_DIR/live-v1.json" "$E2E_RUN_DIR/reattach-v1.json"
echo "  recovery consistent: v1+v2 messages, roles, parents and parts"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-recovery-consistency: PASSED in $((SECONDS - SCRIPT_START))s"
