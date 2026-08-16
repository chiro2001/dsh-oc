#!/usr/bin/env bash
# Real opencode TUI timestamp e2e: seed a session through the bridge API,
# restart dsh with DSH_OC_TUI_TIMESTAMPS=1, and verify the seeded message is
# rendered with a time-of-day timestamp in the tmux pane capture.
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

e2e_new_run "tui-timestamps" "danger-full-access" "success" "1"

echo "== seed a session through the bridge API =="
E2E_ACTIVE_SESSION="dsh-oc-timestamp-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

SESSION="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
curl -s -X POST "$SEED_URL/session/$SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e seed: timestamp session"}]}' | jq -e '.info.role == "assistant"' >/dev/null

deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  TEXT="$(curl -s "$SEED_URL/session/$SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$TEXT" == *"mock response recovered"* ]]; then
    echo "  seeded assistant reply ready"
    break
  fi
  sleep 1
done
if [[ "$TEXT" != *"mock response recovered"* ]]; then
  echo "e2e: seeded assistant reply missing" >&2
  exit 1
fi

echo "== restart dsh with the real TUI and timestamps enabled =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--session $SESSION" "DSH_OC_TUI_TIMESTAMPS=1"
e2e_tui_wait_attach

TUI_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-timestamps.txt"
  if grep -qa "e2e seed: timestamp session" "$E2E_RUN_DIR/tui-timestamps.txt"; then
    TUI_HINT=yes
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: seeded session content not visible in TUI pane" >&2
  exit 1
fi
echo "  seeded content visible"

KV_FILE="$E2E_DSH_HOME/opencode/state/opencode/kv.json"
if [[ ! -f "$KV_FILE" ]] || [[ "$(jq -r .timestamps "$KV_FILE")" != "show" ]]; then
  echo "e2e: kv.json timestamps not seeded: $(cat "$KV_FILE" 2>/dev/null || true)" >&2
  exit 1
fi
echo "  kv.json timestamps=show"

if ! grep -qaE '(^|[^0-9])[0-9]{1,2}:[0-9]{2}([^0-9]|$)' "$E2E_RUN_DIR/tui-timestamps.txt"; then
  echo "e2e: no time-of-day timestamp in TUI pane capture" >&2
  exit 1
fi
echo "  timestamp text visible"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-timestamps-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-timestamps-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-timestamps: PASSED in $((SECONDS - SCRIPT_START))s"
