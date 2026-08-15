#!/usr/bin/env bash
# Attach --continue e2e: seed two sessions (B newer), restart the real TUI
# with --continue and assert the newest session content is shown.
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

e2e_new_run "tui-continue" "danger-full-access" "success,success" "1"

echo "== seed two sessions through the bridge API =="
E2E_ACTIVE_SESSION="dsh-oc-continue-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

seed_session() {
  local text="$1"
  local session
  session="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
  curl -s -X POST "$SEED_URL/session/$session/message" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$text\"}]}" | jq -e '.info.role == "assistant"' >/dev/null
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local got
    got="$(curl -s "$SEED_URL/session/$session/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$got" == *"mock response recovered"* ]]; then break; fi
    sleep 1
  done
  if [[ "$got" != *"mock response recovered"* ]]; then
    echo "e2e: seed reply not seen for $text" >&2
    exit 1
  fi
  echo "$session"
}

SESSION_A="$(seed_session "continue seed A")"
SESSION_B="$(seed_session "continue seed B")"
echo "  seeded A=$SESSION_A B=$SESSION_B"

echo "== restart dsh with --continue =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--continue"
e2e_tui_wait_attach

CONTINUE_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-continue.txt"
  if grep -qa "continue seed B" "$E2E_RUN_DIR/tui-continue.txt"; then
    CONTINUE_HINT="continue seed B"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for --continue TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$CONTINUE_HINT" ]]; then
  echo "e2e: newest session content not visible in --continue TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-continue.txt" >&2 || true
  exit 1
fi
echo "  newest session visible: $CONTINUE_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-continue-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-continue-after.txt"; then
  echo "e2e: shell prompt not restored after --continue TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-continue: PASSED in $((SECONDS - SCRIPT_START))s"
