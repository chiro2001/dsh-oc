#!/usr/bin/env bash
# /preset inheritance e2e: switch the agent preset before any conversation
# (`/preset minimal`), create a fresh session from the TUI, submit a prompt,
# and assert the new dsh session carries the minimal preset (regression for
# "对话前 /preset 无法改变 preset").
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

export DSH_OC_E2E_CHUNK_DELAY_MS=30
export DSH_OC_E2E_CHUNK_SIZE=8
e2e_new_run "tui-preset-inherit" "danger-full-access" "success,success" "1"
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

echo "== /preset minimal before any conversation =="
tmux send-keys -t "$E2E_TUI_SESSION" '/preset minimal' Enter
tmux send-keys -t "$E2E_TUI_SESSION" Enter
sleep 2
e2e_tui_capture "$E2E_RUN_DIR/tui-preset-cmd.txt"
if ! grep -qa 'minimal' "$E2E_RUN_DIR/tui-preset-cmd.txt"; then
  echo "  note: /preset minimal result not matched in pane (continuing)" >&2
fi

echo "== create a fresh session (same bridge inherits lastAgentPreset) =="
NEW_SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  NEW_SID="$(curl -s -X POST "$E2E_BRIDGE_URL/session" -H 'Content-Type: application/json' \
    -d '{}' | jq -r '.id // empty' 2>/dev/null || true)"
  if [[ -n "$NEW_SID" ]]; then break; fi
  sleep 1
done
[[ -n "$NEW_SID" ]]
echo "  new session: $NEW_SID"

echo "== submit a prompt and wait for the reply =="
curl -s -X POST "$E2E_BRIDGE_URL/session/$NEW_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"preset inherit check"}]}' >/dev/null
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  text="$(curl -s "$E2E_BRIDGE_URL/session/$NEW_SID/message" \
    | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$text" == *"preset inherit check"* && "$text" == *"mock response recovered"* ]]; then
    break
  fi
  sleep 1
done
if [[ "$text" != *"mock response recovered"* ]]; then
  echo "e2e: prompt did not complete a turn" >&2
  exit 1
fi

echo "== assert the new session inherited the minimal preset =="
AGENT="$(curl -s "$E2E_BRIDGE_URL/api/session/$NEW_SID" | jq -r '.data.agent // empty' 2>/dev/null || true)"
echo "  new session agent: ${AGENT:-<unset>}"
if [[ "$AGENT" != "minimal" ]]; then
  echo "e2e: /preset minimal was not inherited by the new session (agent=$AGENT)" >&2
  exit 1
fi
echo "  /preset minimal inherited by the new session"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-preset-inherit: PASSED in $((SECONDS - SCRIPT_START))s"
