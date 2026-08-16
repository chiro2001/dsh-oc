#!/usr/bin/env bash
# Real opencode TUI /goal command e2e: typing `/goal <objective>` in the TUI
# must create the goal with the FULL objective (regression: the line used to
# be split into `/goal` plus the previous message) and must not re-send the
# previous user prompt. The goal tool auto-starts rounds once armed, so the
# test interrupts promptly after asserting the goal state.
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

echo "== TUI /goal with a full objective =="
export DSH_OC_E2E_CHUNK_DELAY_MS=50
export DSH_OC_E2E_CHUNK_SIZE=20
e2e_new_run "tui-goal-command" "danger-full-access" "success" "1"
e2e_tui_start ""
e2e_tui_wait_attach

READY=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
  if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt"; then
    READY="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
[[ -n "$READY" ]]
echo "  TUI ready"

# Seed a previous user prompt so a regression would re-send it after /goal.
tmux send-keys -t "$E2E_TUI_SESSION" 'first marker message' Enter

SID=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_assistant_text "$E2E_BRIDGE_URL/session/$SID/message" "mock response recovered"
echo "  first reply seen"

GOAL_OBJECTIVE="按计划完成SVE实验"
tmux send-keys -t "$E2E_TUI_SESSION" "/goal $GOAL_OBJECTIVE" Enter

TODO_OK=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  if curl -s "$E2E_BRIDGE_URL/session/$SID/todo" \
    | jq -e --arg goal "Goal: $GOAL_OBJECTIVE" 'any(.[]; .content == $goal)' >/dev/null 2>&1; then
    TODO_OK="1"
    break
  fi
  sleep 1
done
if [[ -z "$TODO_OK" ]]; then
  echo "e2e: goal not created with the full objective" >&2
  curl -s "$E2E_BRIDGE_URL/session/$SID/todo" >&2 || true
  exit 1
fi
echo "  goal created with the full objective"

GOAL_TEXT_SEEN=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-goal-cmd.txt"
  if grep -qa "$GOAL_OBJECTIVE" "$E2E_RUN_DIR/tui-goal-cmd.txt"; then
    GOAL_TEXT_SEEN="1"
    break
  fi
  sleep 1
done
if [[ -z "$GOAL_TEXT_SEEN" ]]; then
  echo "e2e: objective text not visible in the TUI" >&2
  tail -40 "$E2E_RUN_DIR/tui-goal-cmd.txt" >&2 || true
  exit 1
fi
echo "  objective visible in the TUI"

# Stop the auto-started goal rounds before inspecting the transcript.
tmux send-keys -t "$E2E_TUI_SESSION" Escape Escape
sleep 2

USER_TEXTS="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message?limit=500" \
  | jq -r '[.[] | select(.info.role == "user") | .parts[] | select(.type == "text") | .text] | .[]' 2>/dev/null || true)"
if [[ "$(grep -c '^first marker message$' <<<"$USER_TEXTS" || true)" != "1" ]]; then
  echo "e2e: previous prompt was re-sent or lost (marker count != 1)" >&2
  grep -c '^first marker message$' <<<"$USER_TEXTS" >&2 || true
  curl -s "$E2E_BRIDGE_URL/session/$SID/message?limit=500" | jq -r '[.[] | select(.info.role == "user") | .parts[] | select(.type == "text") | .text] | .[]' >&2 || true
  exit 1
fi
if grep -qx '/goal' <<<"$USER_TEXTS"; then
  echo "e2e: /goal was sent as a bare line (split input regression)" >&2
  exit 1
fi
if ! grep -q "Objective: \"$GOAL_OBJECTIVE\"" <<<"$USER_TEXTS"; then
  echo "e2e: no goal round carried the full objective" >&2
  exit 1
fi
echo "  no split /goal line; previous prompt not re-sent; goal rounds carry the full objective"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-goal-cmd-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-goal-cmd-after.txt"; then
  echo "e2e: shell prompt not restored after /goal TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-goal-command: PASSED in $((SECONDS - SCRIPT_START))s"
