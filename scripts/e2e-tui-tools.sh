#!/usr/bin/env bash
# Real opencode TUI tool/diff e2e: mock LLM drives bash and
# str_replace_editor file writes through the bridge, API diff endpoints expose
# the file changes, and the real TUI renders the "Modified Files" sidebar.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
SSE_PID=""

cleanup() {
  local code=$?
  if [[ -n "$SSE_PID" ]]; then
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
  fi
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

wait_assistant_text() {
  local url="$1"
  local want="$2"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$url" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$text" == *"$want"* ]]; then
      return 0
    fi
    sleep 2
  done
  echo "e2e: assistant reply not seen for $url" >&2
  curl -s "$url" >&2 || true
  return 1
}

seed_tool_session() {
  local bridge="$1"
  local session
  session="$(curl -s -X POST "$bridge/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
  curl -s -X POST "$bridge/session/$session/message" -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"e2e: write a file with a tool"}]}' | jq -e '.info.role == "assistant"' >/dev/null
  echo "$session"
}

start_sse() {
  local bridge="$1"
  local file="$2"
  curl -sN --max-time 180 "$bridge/global/event" > "$file" &
  SSE_PID=$!
  sleep 2
}

stop_sse() {
  if [[ -n "$SSE_PID" ]]; then
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
    SSE_PID=""
  fi
}

echo "== bash tool file write =="
e2e_new_run "tools-bash" "danger-full-access" "tool_call_success,success" "1" \
  '{"command":"mkdir -p src && printf \"hello\\n\" > src/generated.txt","description":"e2e bash file write"}'
E2E_ACTIVE_SESSION="dsh-oc-tools-bash"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
BASH_BRIDGE="$E2E_BRIDGE_URL"
start_sse "$BASH_BRIDGE" "$E2E_RUN_DIR/tools-bash-sse.txt"
BASH_SESSION="$(seed_tool_session "$BASH_BRIDGE")"
echo "  bash session: $BASH_SESSION"
wait_assistant_text "$BASH_BRIDGE/session/$BASH_SESSION/message" "mock response recovered"

BASH_TOOL="$(curl -s "$BASH_BRIDGE/session/$BASH_SESSION/message" | jq -r '[.. | objects | select(.type == "tool") | .tool] | join(" ")')"
[[ "$BASH_TOOL" == *bash* ]]
echo "  bash tool card: $BASH_TOOL"
BASH_OUTPUT="$(curl -s "$BASH_BRIDGE/session/$BASH_SESSION/message" | jq -r '[.. | objects | select(.type == "tool" and .tool == "bash") | (.state.output // .state.metadata.output // "")] | join(" ")')"
echo "  bash card output: ${BASH_OUTPUT:0:40}"
BASH_DIFF="$(curl -s "$BASH_BRIDGE/api/session/$BASH_SESSION/diff")"
jq -e --arg file "src/generated.txt" 'any(.[]; .file == $file)' <<<"$BASH_DIFF" >/dev/null
echo "  bash diff visible: $(jq -r '.[0].file' <<<"$BASH_DIFF")"
[[ -f "$E2E_WORKDIR/src/generated.txt" ]]
echo "  bash wrote workdir file"

stop_sse
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
e2e_stop_run

echo "== str_replace_editor file write =="
e2e_new_run "tools-edit" "danger-full-access" "tool_call_success,success" "1" \
  '{"command":"create","path":"@WORKDIR@/created.txt","file_text":"created by str_replace_editor\n"}' \
  "str_replace_editor"
E2E_ACTIVE_SESSION="dsh-oc-tools-edit"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
EDIT_BRIDGE="$E2E_BRIDGE_URL"
start_sse "$EDIT_BRIDGE" "$E2E_RUN_DIR/tools-edit-sse.txt"
EDIT_SESSION="$(seed_tool_session "$EDIT_BRIDGE")"
echo "  edit session: $EDIT_SESSION"
wait_assistant_text "$EDIT_BRIDGE/session/$EDIT_SESSION/message" "mock response recovered"

EDIT_TOOL_JSON="$(curl -s "$EDIT_BRIDGE/session/$EDIT_SESSION/message" | jq -c '[.. | objects | select(.type == "tool") | {tool,state}] | .[0]')"
jq -e '.tool == "edit" and .state.status == "completed" and (.state.metadata.diff | type) == "string" and (.state.metadata.diff | length > 0)' <<<"$EDIT_TOOL_JSON" >/dev/null
echo "  str_replace_editor rendered as edit card with metadata.diff"
EDIT_DIFF="$(curl -s "$EDIT_BRIDGE/api/session/$EDIT_SESSION/diff")"
jq -e 'any(.[]; (.file | endswith("created.txt")) and (.patch | type) == "string" and (.patch | length > 0) and .additions == 1)' <<<"$EDIT_DIFF" >/dev/null
echo "  edit diff visible: $(jq -r '.[0].file' <<<"$EDIT_DIFF")"
[[ -f "$E2E_WORKDIR/created.txt" ]]
echo "  str_replace_editor wrote workdir file"

stop_sse

echo "== real TUI file changes =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
e2e_tui_start "--session $EDIT_SESSION"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"

SYNCED_DIFF="$(curl -s "$TUI_URL/api/session/$EDIT_SESSION/diff")"
jq -e 'any(.[]; .file | endswith("created.txt"))' <<<"$SYNCED_DIFF" >/dev/null
echo "  TUI bridge diff API returns the created file"

TUI_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-tools.txt"
  for pattern in "Modified Files" "created.txt"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-tools.txt"; then
      TUI_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI file changes: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
echo "  pane bytes: $(wc -c < "$E2E_RUN_DIR/tui-tools.txt")"
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: no Modified Files / created.txt in TUI pane" >&2
  exit 1
fi
echo "  TUI file changes visible: \"$TUI_HINT\""

e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-tools-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-tools-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-tools: PASSED in $((SECONDS - SCRIPT_START))s"
