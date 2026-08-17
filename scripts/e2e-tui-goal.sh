#!/usr/bin/env bash
# Real opencode TUI goal e2e: mock LLM creates a goal through create_goal,
# then the TUI resumes the session and renders the goal in the Todo sidebar.
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

echo "== seed a goal through create_goal =="
e2e_new_run "tui-goal" "danger-full-access" "tool_call_success,success" "0" \
  '{"objective":"ship e2e goal support"}' \
  "create_goal"
E2E_ACTIVE_SESSION="dsh-oc-tui-goal-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_BRIDGE="$E2E_BRIDGE_URL"

# Run the goal surface on the standard preset: the goal tool must be in the
# session's catalog, which a deployment may restrict away from minimal.
GOAL_SESSION="$(curl -s -X POST "$SEED_BRIDGE/session" -H 'Content-Type: application/json' -d '{"agent":"standard"}' | jq -er .id)"
echo "  goal session: $GOAL_SESSION"
curl -s -X POST "$SEED_BRIDGE/session/$GOAL_SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: create a goal"}]}' | jq -e '.info.role == "assistant"' >/dev/null
wait_assistant_text "$SEED_BRIDGE/session/$GOAL_SESSION/message" "Goal created: ship e2e goal support"
curl -s "$SEED_BRIDGE/session/$GOAL_SESSION/todo" \
  | jq -e --arg goal 'Goal: ship e2e goal support' 'any(.[]; .content == $goal)' >/dev/null
echo "  goal persisted and visible through the todo route"

e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

echo "== real TUI shows the goal in the Todo sidebar =="
e2e_tui_start "--session $GOAL_SESSION"
e2e_tui_wait_attach

TUI_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-goal.txt"
  if grep -qa "Todo" "$E2E_RUN_DIR/tui-goal.txt" \
    && grep -qa "Goal: ship e2e goal support" "$E2E_RUN_DIR/tui-goal.txt"; then
    TUI_HINT="Todo + goal"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for goal sidebar: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: goal not visible in TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-goal.txt" >&2 || true
  exit 1
fi
echo "  goal visible: $TUI_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-goal-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-goal-after.txt"; then
  echo "e2e: shell prompt not restored after goal TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-goal: PASSED in $((SECONDS - SCRIPT_START))s"
