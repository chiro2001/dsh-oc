#!/usr/bin/env bash
# dsh-oc goal API e2e: mock LLM drives create_goal, the bridge translates
# the durable goal/change into a merged todo.updated, GET /session/:id/todo
# returns the goal first, and /goal works through the command registry.
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
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "api-goal" "danger-full-access" "tool_call_success,success" "0" \
  '{"objective":"ship e2e goal support"}' \
  "create_goal"
E2E_ACTIVE_SESSION="dsh-oc-api-goal"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"

curl -s "$BRIDGE/command" | jq -e '([.[].name] | index("goal") != null)' >/dev/null
echo "  /command advertises /goal"
curl -s "$BRIDGE/api/command" | jq -e '([.data[].name] | index("goal") != null)' >/dev/null
echo "  /api/command advertises /goal"

SSE_FILE="$E2E_RUN_DIR/goal-sse.txt"
curl -sN --max-time 120 "$BRIDGE/global/event" > "$SSE_FILE" &
SSE_PID=$!
sleep 2

SESSION="$(curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
echo "  goal session: $SESSION"
curl -s -X POST "$BRIDGE/session/$SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: create a goal"}]}' | jq -e '.info.role == "assistant"' >/dev/null
echo "  goal prompt accepted"

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
wait_assistant_text "$BRIDGE/session/$SESSION/message" "Goal created: ship e2e goal support"

TODO_JSON="$(curl -s "$BRIDGE/session/$SESSION/todo")"
jq -e --arg goal 'Goal: ship e2e goal support' 'any(.[]; .content == $goal and .status == "in_progress" and .priority == "high")' <<<"$TODO_JSON" >/dev/null
echo "  /session/$SESSION/todo returns the active goal first"

GOAL_OUT="$(curl -s -X POST "$BRIDGE/session/$SESSION/command" -H 'Content-Type: application/json' \
  -d '{"command":"goal","arguments":""}')"
jq -e '.parts[0].text | contains("Status: active") and contains("ship e2e goal support")' <<<"$GOAL_OUT" >/dev/null
echo "  POST /session/$SESSION/command /goal shows the current goal"

SESSION2="$(curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
GOAL_CREATE_OUT="$(curl -s -X POST "$BRIDGE/session/$SESSION2/command" -H 'Content-Type: application/json' \
  -d '{"command":"goal","arguments":"ship a second goal"}')"
jq -e '.parts[0].text | contains("Goal created") and contains("ship a second goal")' <<<"$GOAL_CREATE_OUT" >/dev/null
echo "  POST /session/$SESSION2/command /goal <objective> creates a goal"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
grep '^data: ' "$SSE_FILE" | sed 's/^data: //' > "$E2E_RUN_DIR/goal-sse-data.txt"
grep -q '"type":"todo.updated".*ship e2e goal support' "$E2E_RUN_DIR/goal-sse-data.txt"
echo "  SSE todo.updated carries the goal"

e2e_stop_dsh "$E2E_ACTIVE_SESSION"
e2e_stop_run

echo "e2e-api-goal: PASSED in $((SECONDS - SCRIPT_START))s"
