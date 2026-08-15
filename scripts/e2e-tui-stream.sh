#!/usr/bin/env bash
# Real opencode TUI streaming e2e: a slow mock LLM emits a long success text
# token by token; the TUI pane must grow while the turn is still running, and
# the final assistant message must carry a real completed-created duration.
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

LONG_TEXT="streaming e2e mock response: the quick brown fox jumps over the lazy dog while the bridge streams text chunks into the opencode pane until the full success text is visible"
PARTIAL="${LONG_TEXT:0:16}"
export DSH_OC_E2E_SUCCESS_TEXT="$LONG_TEXT"
export DSH_OC_E2E_CHUNK_DELAY_MS=120
export DSH_OC_E2E_CHUNK_SIZE=2

e2e_new_run "tui-stream" "danger-full-access" "slow_success,slow_success,slow_success,slow_success" "1"

echo "== boot dsh + real opencode attach =="
e2e_tui_start ""
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"

TUI_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-stream-boot.txt"
  if grep -qa "Ask anything" "$E2E_RUN_DIR/tui-stream-boot.txt"; then
    TUI_HINT="Ask anything"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: TUI prompt box did not render" >&2
  exit 1
fi
echo "  TUI ready: \"$TUI_HINT\""

echo "== send streaming prompt =="
tmux send-keys -t "$E2E_TUI_SESSION" "e2e stream prompt: repeat the full text" Enter

echo "== wait for partial streamed text =="
PARTIAL_SEEN=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-stream-wait.txt"
  if grep -qaF "$PARTIAL" "$E2E_RUN_DIR/tui-stream-wait.txt"; then
    PARTIAL_SEEN=yes
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for stream: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 0.5
done
if [[ -z "$PARTIAL_SEEN" ]]; then
  echo "e2e: no partial streamed text appeared in pane" >&2
  exit 1
fi
echo "  partial streamed text visible"

echo "== capture two in-flight panes =="
TEXT_A=0
TEXT_B=0
deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-stream-a.txt"
  TEXT_A="$(grep -a '^     streaming' "$E2E_RUN_DIR/tui-stream-a.txt" | head -1 | wc -c)"
  sleep 0.75
  e2e_tui_capture "$E2E_RUN_DIR/tui-stream-b.txt"
  TEXT_B="$(grep -a '^     streaming' "$E2E_RUN_DIR/tui-stream-b.txt" | head -1 | wc -c)"
  echo "  streamed text bytes: $TEXT_A -> $TEXT_B"
  if (( TEXT_B > TEXT_A )); then
    break
  fi
done
if (( TEXT_B <= TEXT_A )); then
  echo "e2e: visible streamed text did not grow while streaming ($TEXT_A -> $TEXT_B)" >&2
  exit 1
fi

echo "== wait for complete success text =="
COMPLETE_SEEN=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-stream-final.txt"
  if grep -qaF "$LONG_TEXT" "$E2E_RUN_DIR/tui-stream-final.txt"; then
    COMPLETE_SEEN=yes
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited before stream completed: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$COMPLETE_SEEN" ]]; then
  echo "e2e: complete success text never appeared in pane" >&2
  exit 1
fi
echo "  complete success text visible"

echo "== assert real message duration in API history =="
SESSION_ID="$(curl -s "$TUI_URL/session" | jq -er '.[-1].id')"
DURATIONS="$(curl -s "$TUI_URL/session/$SESSION_ID/message" | jq -c '[.[] | select(.info.role == "assistant" and .info.time.completed != null) | .info.time.completed - .info.time.created]')"
echo "  assistant durations: $DURATIONS"
if ! jq -e 'any(. > 0)' <<<"$DURATIONS" >/dev/null; then
  echo "e2e: no assistant message reports time.completed > time.created" >&2
  exit 1
fi

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-stream-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-stream-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-stream: PASSED in $((SECONDS - SCRIPT_START))s"
