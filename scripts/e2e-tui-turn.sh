#!/usr/bin/env bash
# Real opencode TUI turn e2e: seed one text session and one tool-call session
# through the bridge API, attach the real TUI to the tool session, verify the
# history renders, send a new prompt from the TUI keyboard, and confirm the
# reply lands in dsh before exiting cleanly.
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

e2e_new_run "tui-turn" "danger-full-access" "tool_call_success,success,success,success,success,success,success,success" "0" \
  '{"command":"echo dsh-oc-e2e-tool","description":"e2e tool call"}'

echo "== seed sessions through the bridge API =="
E2E_ACTIVE_SESSION="dsh-oc-api-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

seed_session() {
  local text="$1"
  local session
  session="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
  curl -s -X POST "$SEED_URL/session/$session/message" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$text\"}]}" | jq -e '.info.role == "assistant"' >/dev/null
  echo "$session"
}

TOOL_SESSION="$(seed_session "e2e seed: tool session")"
echo "  tool session: $TOOL_SESSION"
PLAIN_SESSION="$(seed_session "e2e seed: plain text session")"
echo "  plain session: $PLAIN_SESSION"

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
  return 1
}

wait_assistant_text "$SEED_URL/session/$PLAIN_SESSION/message" "mock response recovered"
echo "  plain session has assistant reply"
wait_assistant_text "$SEED_URL/session/$TOOL_SESSION/message" "mock response recovered"
echo "  tool session has assistant reply"

LIST_TITLE="$(curl -s "$SEED_URL/session" | jq -r --arg id "$TOOL_SESSION" '[.[] | select(.id == $id)][0].title')"
WORK_BASENAME="$(basename "$E2E_WORKDIR")"
if [[ -z "$LIST_TITLE" || "$LIST_TITLE" == "$WORK_BASENAME" ]]; then
  echo "e2e: session list lacks a durable title (got: $LIST_TITLE)" >&2
  exit 1
fi
echo "  session list shows durable title: $LIST_TITLE"

TOOL_TEXT="$(curl -s "$SEED_URL/session/$TOOL_SESSION/message" | jq -r '[.. | objects | select(has("tool") and .type == "tool") | .tool] | join(" ")')"
if [[ "$TOOL_TEXT" != *bash* ]]; then
  echo "e2e: tool session has no bash tool card: $TOOL_TEXT" >&2
  exit 1
fi
echo "  tool session tool card: $TOOL_TEXT"

echo "== restart dsh with the real TUI attached to the tool session =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--session $TOOL_SESSION"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"

SEED_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-turn-boot.txt"
  for pattern in "e2e seed: tool session" "mock response recovered" "bash" "dsh-oc-e2e-tool"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-turn-boot.txt"; then
      SEED_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    cat "$E2E_RUN_DIR/dsh-stderr.txt" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "  pane bytes: $(wc -c < "$E2E_RUN_DIR/tui-turn-boot.txt")"
if [[ -z "$SEED_HINT" ]]; then
  echo "e2e: seeded session content not visible in TUI pane" >&2
  exit 1
fi
echo "  seeded content visible: \"$SEED_HINT\""

BEFORE_COUNT="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message" | jq 'length')"
echo "== keyboard prompt =="
tmux send-keys -t "$E2E_TUI_SESSION" "e2e tui prompt: hello" Enter

NEW_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-turn-live.txt"
  if grep -qa "e2e tui prompt: hello" "$E2E_RUN_DIR/tui-turn-live.txt"; then
    NEW_HINT="user text echoed"
    break
  fi
  local_turn_text="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$local_turn_text" == *"e2e tui prompt: hello"* && "$local_turn_text" == *"mock response recovered"* ]]; then
    NEW_HINT="turn completed via API"
    break
  fi
  sleep 1
done
if [[ -z "$NEW_HINT" ]]; then
  echo "e2e: TUI prompt did not land in the session" >&2
  exit 1
fi
echo "  new prompt visible: $NEW_HINT"

AFTER_COUNT="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message" | jq 'length')"
if (( AFTER_COUNT <= BEFORE_COUNT )); then
  echo "e2e: session message count did not grow ($BEFORE_COUNT -> $AFTER_COUNT)" >&2
  exit 1
fi
echo "  session messages grew: $BEFORE_COUNT -> $AFTER_COUNT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-turn-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-turn-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-turn: PASSED in $((SECONDS - SCRIPT_START))s"
