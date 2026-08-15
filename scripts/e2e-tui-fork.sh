#!/usr/bin/env bash
# Attach fork e2e: seed a session through the bridge API, then start the real
# opencode TUI with `--fork --session <id>` and assert the forked session is
# visible with its "fork #1" title before exiting cleanly.
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

e2e_new_run "tui-fork" "danger-full-access" "success" "1"

echo "== seed a session through the bridge API =="
E2E_ACTIVE_SESSION="dsh-oc-fork-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

SESSION="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
curl -s -X POST "$SEED_URL/session/$SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e fork seed"}]}' | jq -e '.info.role == "assistant"' >/dev/null
local_text=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  local_text="$(curl -s "$SEED_URL/session/$SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$local_text" == *"mock response recovered"* ]]; then break; fi
  sleep 1
done
if [[ "$local_text" != *"mock response recovered"* ]]; then
  echo "e2e: seeded assistant reply not seen" >&2
  exit 1
fi
echo "  seeded session: $SESSION"

echo "== restart dsh with --fork --session =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--fork --session $SESSION"
e2e_tui_wait_attach

FORK_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-fork.txt"
  if grep -qa "fork #1" "$E2E_RUN_DIR/tui-fork.txt"; then
    FORK_HINT="fork #1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for fork TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$FORK_HINT" ]]; then
  echo "e2e: forked session title not visible in TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-fork.txt" >&2 || true
  exit 1
fi
echo "  forked session visible: $FORK_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-fork-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-fork-after.txt"; then
  echo "e2e: shell prompt not restored after fork TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-fork: PASSED in $((SECONDS - SCRIPT_START))s"
