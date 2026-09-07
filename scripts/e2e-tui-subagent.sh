#!/usr/bin/env bash
# Real opencode TUI subagent e2e. The first phase uses an isolated dsh profile
# plus the deterministic mock to create a real dsh session-backed subagent;
# the second phase restarts dsh with the official opencode attach TUI and
# verifies Task rendering, child navigation, and history hydration.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
DESCRIPTION="e2e subagent child"
SUBAGENT_PROMPT="Reply exactly with E2E_SUBAGENT_CHILD_OK and nothing else."
SUBAGENT_ARGS="$(jq -nc --arg description "$DESCRIPTION" --arg prompt "$SUBAGENT_PROMPT" \
  '{description:$description,prompt:$prompt,run_in_background:false}')"

cleanup() {
  local code=$?
  e2e_tui_io_monitor_cleanup || true
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

# The helper observes only the exact opencode attach PID found for this run.
export DSH_OC_E2E_MONITOR_IO=1
export DSH_OC_E2E_MONITOR_INTERVAL="${DSH_OC_E2E_MONITOR_INTERVAL:-0.25}"
export DSH_OC_E2E_MONITOR_READ_THRESHOLD="${DSH_OC_E2E_MONITOR_READ_THRESHOLD:-33554432}"

e2e_new_run "tui-subagent" "danger-full-access" "tool_call_success,success,success" "1" "$SUBAGENT_ARGS" "subagent"

echo "== create a real dsh child through the isolated bridge =="
E2E_ACTIVE_SESSION="dsh-oc-subagent-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"
PARENT_ID="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
PROMPT_BODY="$(jq -nc --arg text "e2e parent creates a subagent" '{parts:[{type:"text",text:$text}]}')"
curl -s -X POST "$SEED_URL/session/$PARENT_ID/message" \
  -H 'Content-Type: application/json' -d "$PROMPT_BODY" >/dev/null
echo "  parent session: $PARENT_ID"

TASK_JSON=""
CHILD_ID=""
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  PARENT_MESSAGES="$(curl -s -m 5 "$SEED_URL/session/$PARENT_ID/message" || true)"
  TASK_JSON="$(jq -c '[.. | objects | select(.type == "tool" and .tool == "task")][-1] // empty' <<<"$PARENT_MESSAGES" 2>/dev/null || true)"
  CHILD_ID="$(jq -r '.state.metadata.sessionId // empty' <<<"$TASK_JSON" 2>/dev/null || true)"
  if [[ -n "$CHILD_ID" && "$TASK_JSON" != "" && "$TASK_JSON" != "null" ]]; then
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: seed dsh exited before the task child appeared: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$CHILD_ID" ]]; then
  echo "e2e: task metadata did not expose a child session" >&2
  jq '.' <<<"$PARENT_MESSAGES" >&2 || true
  exit 1
fi

TASK_TOOL="$(jq -r '.tool' <<<"$TASK_JSON")"
TASK_DESCRIPTION="$(jq -r '.state.input.description // empty' <<<"$TASK_JSON")"
TASK_TYPE="$(jq -r '.state.input.subagent_type // empty' <<<"$TASK_JSON")"
TASK_PARENT="$(jq -r '.state.metadata.parentSessionId // empty' <<<"$TASK_JSON")"
if [[ "$TASK_TOOL" != task || "$TASK_DESCRIPTION" != "$DESCRIPTION" || -z "$TASK_TYPE" \
  || "$TASK_PARENT" != "$PARENT_ID" ]]; then
  echo "e2e: invalid task mapping" >&2
  jq '.' <<<"$TASK_JSON" >&2
  exit 1
fi
echo "  task mapped: type=$TASK_TYPE description=$TASK_DESCRIPTION child=$CHILD_ID"

CHILD_SUMMARY="$(curl -s -m 5 "$SEED_URL/session/$CHILD_ID" || true)"
if ! jq -e --arg id "$CHILD_ID" --arg parent "$PARENT_ID" \
  '.id == $id and .parentID == $parent and .metadata.origin == "subagent"' <<<"$CHILD_SUMMARY" >/dev/null; then
  echo "e2e: child session lineage is incomplete" >&2
  jq '.' <<<"$CHILD_SUMMARY" >&2 || true
  exit 1
fi
echo "  child lineage: parentID=$PARENT_ID origin=subagent"

if ! jq -e --arg id "$CHILD_ID" --arg description "$DESCRIPTION" \
  'any(.[]; .info.role == "assistant" and any(.parts[]?; .tool == "task" and .state.metadata.sessionId == $id and .state.input.description == $description))' \
  <<<"$PARENT_MESSAGES" >/dev/null; then
  echo "e2e: parent history lost the completed task metadata" >&2
  exit 1
fi
echo "  history task metadata retained after child completion"

echo "== restart with the official opencode TUI =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
e2e_tui_start "--session $PARENT_ID"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"
ATTACH_PID="$E2E_TUI_ATTACH_PID"
MONITOR_LOG="$E2E_TUI_IO_MONITOR_LOG"
if [[ ! "$ATTACH_PID" =~ ^[0-9]+$ || -z "$MONITOR_LOG" ]]; then
  echo "e2e: attach monitor did not bind to an exact PID" >&2
  exit 1
fi

TASK_PANE=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-subagent-parent.txt"
  if grep -qa "${TASK_TYPE^} Task" "$E2E_RUN_DIR/tui-subagent-parent.txt" \
    && grep -qa "$DESCRIPTION" "$E2E_RUN_DIR/tui-subagent-parent.txt"; then
    TASK_PANE="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: TUI dsh exited before Task rendering: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$TASK_PANE" ]]; then
  echo "e2e: Task card not visible in the official TUI pane" >&2
  tail -80 "$E2E_RUN_DIR/tui-subagent-parent.txt" >&2 || true
  exit 1
fi
echo "  parent pane shows ${TASK_TYPE^} Task — $DESCRIPTION"

echo "== navigate to the child session with the TUI child binding =="
tmux send-keys -t "$E2E_TUI_SESSION" C-x Down
CHILD_PANE=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-subagent-child.txt"
  if grep -qa 'E2E_SUBAGENT_CHILD_OK' "$E2E_RUN_DIR/tui-subagent-child.txt"; then
    CHILD_PANE="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: TUI dsh exited before child navigation: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$CHILD_PANE" ]]; then
  echo "e2e: child session was not navigable from the parent TUI" >&2
  tail -80 "$E2E_RUN_DIR/tui-subagent-child.txt" >&2 || true
  exit 1
fi
echo "  child pane visible: E2E_SUBAGENT_CHILD_OK"

echo "== ordering and duplicate guard on the recovered parent history =="
RECOVERED="$(curl -s -m 5 "$TUI_URL/session/$PARENT_ID/message")"
USER_INDEX="$(jq -r '[.[] | select(.info.role == "user") | .parts[]?.text // empty] | index("e2e parent creates a subagent") // -1' <<<"$RECOVERED")"
TASK_COUNT="$(jq '[.. | objects | select(.type == "tool" and .tool == "task")] | length' <<<"$RECOVERED")"
if [[ "$USER_INDEX" == "-1" || "$TASK_COUNT" != "1" ]]; then
  echo "e2e: recovered parent ordering/task count invalid" >&2
  exit 1
fi
echo "  recovered parent has one user prompt and one Task part"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks
if [[ ! -s "$MONITOR_LOG" ]]; then
  echo "e2e: exact attach PID monitor produced no samples (pid=$ATTACH_PID)" >&2
  exit 1
fi
echo "  observe-only monitor samples: pid=$ATTACH_PID log=$MONITOR_LOG"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-subagent: PASSED in $((SECONDS - SCRIPT_START))s"
