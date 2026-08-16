#!/usr/bin/env bash
# Real opencode TUI agent-lock e2e: after a session has produced a reply,
# pressing Tab and submitting the next prompt must NOT switch the dsh agent;
# the bridge broadcasts an "Agent switch locked" notice exactly once. The
# prompt still completes on the original agent.
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
    if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt"; then
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

wait_assistant_text() {
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
  echo "e2e: assistant reply not seen for $url" >&2
  curl -s "$url" >&2 || true
  return 1
}

export DSH_OC_E2E_CHUNK_DELAY_MS=30
export DSH_OC_E2E_CHUNK_SIZE=20
e2e_new_run "tui-agent-lock" "danger-full-access" "success" "1"
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

AGENTS="$(curl -s "$E2E_BRIDGE_URL/agent")"
FIRST="$(jq -r '.[0].name // empty' <<<"$AGENTS")"
SECOND="$(jq -r '.[1].name // empty' <<<"$AGENTS")"
if [[ -z "$FIRST" || -z "$SECOND" || "$FIRST" == "$SECOND" ]]; then
  echo "e2e: need at least two agents from /agent (got: $FIRST, $SECOND)" >&2
  exit 1
fi
echo "  agents: $FIRST -> $SECOND"

tmux send-keys -t "$E2E_TUI_SESSION" 'first turn message' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"
wait_assistant_text "$E2E_BRIDGE_URL/session/$SID/message" "mock response recovered"
echo "  first turn completed"

echo "== Tab + submit on a session with turns must be locked =="
tmux send-keys -t "$E2E_TUI_SESSION" Tab
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" 'second turn message' Enter

NOTICE_SEEN=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-lock.txt"
  if grep -qa 'Agent switch locked' "$E2E_RUN_DIR/tui-lock.txt"; then
    NOTICE_SEEN="1"
    break
  fi
  sleep 1
done
if [[ -z "$NOTICE_SEEN" ]]; then
  echo "e2e: 'Agent switch locked' notice not visible in the TUI" >&2
  tail -40 "$E2E_RUN_DIR/tui-lock.txt" >&2 || true
  exit 1
fi
echo "  lock notice visible"

wait_assistant_text "$E2E_BRIDGE_URL/session/$SID/message" "second turn message"
SESSION_AGENT="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r --arg id "$SID" '.[] | select(.id == $id) | .agent // empty' 2>/dev/null || true)"
if [[ -z "$SESSION_AGENT" || "$SESSION_AGENT" == "$SECOND" ]]; then
  echo "e2e: agent unexpectedly switched to $SECOND (session agent: $SESSION_AGENT)" >&2
  exit 1
fi
echo "  agent stayed on $SESSION_AGENT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-agent-lock: PASSED in $((SECONDS - SCRIPT_START))s"
