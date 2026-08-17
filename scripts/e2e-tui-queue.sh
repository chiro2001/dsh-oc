#!/usr/bin/env bash
# Real opencode TUI queue e2e: with a permission dialog blocking the first
# turn (busy agent), send a second prompt and verify the TUI shows it as
# QUEUED (the bridge mirrors dsh pending inbox messages as queued user
# messages), then approve the tool and verify the second prompt is eventually
# processed before exiting cleanly.
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

use_standard_preset() {
  printf '\nagent-presets:\n  default: standard\n' >> "$E2E_DSH_HOME/settings.yaml"
}

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

wait_permission_dialog() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local pending
    pending="$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 0)"
    e2e_tui_capture "$E2E_RUN_DIR/tui-queue-dialog.txt"
    if [[ "$pending" != "0" ]] && grep -qa 'Permission required' "$E2E_RUN_DIR/tui-queue-dialog.txt" \
      && grep -qa 'Allow once' "$E2E_RUN_DIR/tui-queue-dialog.txt"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

e2e_new_run "tui-queue" "workspace-write" "tool_call_success,success,success" "1"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

echo "== first prompt blocks on a permission dialog =="
tmux send-keys -t "$E2E_TUI_SESSION" "e2e first blocked prompt" Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
if [[ -z "$SID" ]]; then
  echo "e2e: no session created from the first prompt" >&2
  exit 1
fi
echo "  session $SID"

if ! wait_permission_dialog; then
  echo "e2e: permission dialog did not appear" >&2
  exit 1
fi
echo "  first turn blocked on permission dialog"

echo "== second prompt queues while the agent is busy =="
curl -s -X POST "$E2E_BRIDGE_URL/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e second queued prompt"}]}' >/dev/null

QUEUED_HINT=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-queue-live.txt"
  if grep -qa "QUEUED" "$E2E_RUN_DIR/tui-queue-live.txt"; then
    QUEUED_HINT="second prompt visible with QUEUED badge"
    break
  fi
  sleep 1
done
if [[ -z "$QUEUED_HINT" ]]; then
  echo "e2e: queued prompt was not shown with a QUEUED badge; pane:" >&2
  cat "$E2E_RUN_DIR/tui-queue-live.txt" >&2 2>/dev/null || true
  exit 1
fi
echo "  $QUEUED_HINT"

echo "== second prompt is eventually processed =="
tmux send-keys -t "$E2E_TUI_SESSION" Enter
SECOND_HINT=""
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  text="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  count="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq '[.[] | select(.info.role == "user")] | length' 2>/dev/null || true)"
  # The queued second prompt must appear exactly once in history (the
  # duplicate-user-card regression made it appear twice); the first prompt is
  # the other user message.
  if [[ "$text" == *"e2e second queued prompt"* && "$text" == *"mock response recovered"* && "${count:-0}" == 2 ]]; then
    SECOND_HINT="second turn completed ($count user messages)"
    break
  fi
  sleep 1
done
if [[ -z "$SECOND_HINT" ]]; then
  echo "e2e: second queued prompt was not processed" >&2
  exit 1
fi
echo "  $SECOND_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-queue: PASSED in $((SECONDS - SCRIPT_START))s"
