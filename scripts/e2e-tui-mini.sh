#!/usr/bin/env bash
# Mini attach e2e: dsh --profile oc --mini boots the real opencode TUI in
# minimal mode, renders a recognizable prompt and exits cleanly.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "tui-mini" "danger-full-access" "success" "1"

echo "== boot real opencode attach with --mini =="
e2e_tui_start "--mini"
e2e_tui_wait_attach

MINI_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-mini.txt"
  for pattern in "Ask anything" "OpenCode" "opencode" "1.18.18" "DSH OC"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-mini.txt"; then
      MINI_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for mini TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$MINI_HINT" ]]; then
  echo "e2e: no recognizable mini TUI text in pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-mini.txt" >&2 || true
  exit 1
fi
echo "  mini TUI visible hint: \"$MINI_HINT\""

echo "== type a prompt and verify a model reply =="
tmux send-keys -t "$E2E_TUI_SESSION" "mini reply test" Enter

REPLY_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  for sid in $(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[].id'); do
    local_text="$(curl -s "$E2E_BRIDGE_URL/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$local_text" == *"mini reply test"* && "$local_text" == *"mock response recovered"* ]]; then
      REPLY_HINT="mini reply + mock response"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for mini reply: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$REPLY_HINT" ]]; then
  echo "e2e: --mini did not produce a model reply" >&2
  exit 1
fi
echo "  mini model reply visible: $REPLY_HINT"

e2e_tui_capture "$E2E_RUN_DIR/tui-mini-reply.txt"
REPLY_COUNT="$(grep -o 'mock response recovered' "$E2E_RUN_DIR/tui-mini-reply.txt" | wc -l)"
if [[ "$REPLY_COUNT" != "1" ]]; then
  echo "e2e: --mini rendered the reply $REPLY_COUNT times (expected 1)" >&2
  exit 1
fi
echo "  mini reply rendered once ($REPLY_COUNT)"

echo "== stop the mini TUI harness =="
e2e_stop_dsh "$E2E_TUI_SESSION"
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-mini: PASSED in $((SECONDS - SCRIPT_START))s"
