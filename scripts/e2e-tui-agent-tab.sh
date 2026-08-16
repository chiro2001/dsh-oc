#!/usr/bin/env bash
# Real opencode TUI agent-tab e2e: with the TUI on a fresh session, press
# Tab (agent.cycle), submit a prompt carrying the newly selected agent, and
# verify the dsh session actually switched to that agent preset (bridge
# applyAgentFromBody -> agentPreset.select). Then exit cleanly.
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

e2e_new_run "tui-agent-tab" "danger-full-access" "success,success" "1"
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

AGENTS="$(curl -s "$E2E_BRIDGE_URL/agent")"
FIRST="$(jq -r '.[0].name // empty' <<<"$AGENTS")"
SECOND="$(jq -r '.[1].name // empty' <<<"$AGENTS")"
if [[ -z "$FIRST" || -z "$SECOND" || "$FIRST" == "$SECOND" ]]; then
  echo "e2e: need at least two agents from /agent (got: $FIRST, $SECOND)" >&2
  echo "$AGENTS" >&2
  exit 1
fi
echo "  agents: $FIRST -> $SECOND"

echo "== Tab cycles to the second agent and the prompt carries it =="
tmux send-keys -t "$E2E_TUI_SESSION" Tab
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" "e2e agent tab check" Enter

SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
if [[ -z "$SID" ]]; then
  echo "e2e: prompt did not create a session" >&2
  exit 1
fi
echo "  session $SID"

deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  text="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$text" == *"e2e agent tab check"* && "$text" == *"mock response recovered"* ]]; then
    break
  fi
  sleep 1
done
if [[ "$text" != *"mock response recovered"* ]]; then
  echo "e2e: prompt did not complete a turn" >&2
  exit 1
fi

SESSION_AGENT="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r --arg id "$SID" '.[] | select(.id == $id) | .agent // empty' 2>/dev/null || true)"
echo "  session agent after Tab + submit: ${SESSION_AGENT:-<unset>}"
if [[ -z "$SESSION_AGENT" || "$SESSION_AGENT" == "$FIRST" ]]; then
  echo "e2e: Tab switch did not reach the dsh session (still $FIRST)" >&2
  exit 1
fi
echo "  agent switched: $FIRST -> $SESSION_AGENT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-agent-tab: PASSED in $((SECONDS - SCRIPT_START))s"
