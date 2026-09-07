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
# Observe only the exact official opencode attach PID discovered by the
# shared helper; never scan or terminate unrelated processes.
export DSH_OC_E2E_MONITOR_IO=1
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

e2e_new_run "tui-turn" "danger-full-access" "tool_call_success,success,success,tool_call_success,success,success,success,success" "0" \
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
TOOL_COUNT="$(curl -s "$SEED_URL/session/$TOOL_SESSION/message" | jq '[.. | objects | select(.type == "tool")] | length')"
if [[ "$TOOL_COUNT" != "1" ]]; then
  echo "e2e: expected exactly one tool part in history, got $TOOL_COUNT" >&2
  exit 1
fi
echo "  tool part count: $TOOL_COUNT"

echo "== restart dsh with the real TUI attached to the tool session =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--session $TOOL_SESSION"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"
ATTACH_PID="$E2E_TUI_ATTACH_PID"
MONITOR_LOG="$E2E_TUI_IO_MONITOR_LOG"
if [[ ! "$ATTACH_PID" =~ ^[0-9]+$ || -z "$MONITOR_LOG" ]]; then
  echo "e2e: attach monitor did not bind to an exact PID" >&2
  exit 1
fi

SEED_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-turn-boot.txt"
  if grep -qa 'e2e seed: tool session' "$E2E_RUN_DIR/tui-turn-boot.txt" \
    && grep -qa 'mock response recovered' "$E2E_RUN_DIR/tui-turn-boot.txt"; then
    SEED_HINT="user+assistant"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
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

# dsh emits turn/start before user/message; the bridge must still expose the
# visible user card before its assistant reply. Check both the durable API
# order and the short real-TUI pane capture so a timestamp-only fix cannot
# silently leave the first card hidden behind the reply.
SEED_HISTORY="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message")"
SEED_USER_COUNT="$(jq '[.[] | select(.info.role == "user")] | length' <<<"$SEED_HISTORY")"
SEED_ASSISTANT_COUNT="$(jq '[.[] | select(.info.role == "assistant")] | length' <<<"$SEED_HISTORY")"
if [[ "$SEED_USER_COUNT" != "1" || "$SEED_ASSISTANT_COUNT" -lt "1" ]]; then
  echo "e2e: seed history role count invalid (user=$SEED_USER_COUNT assistant=$SEED_ASSISTANT_COUNT)" >&2
  exit 1
fi
SEED_USER_LINE="$(grep -n -m1 'e2e seed: tool session' "$E2E_RUN_DIR/tui-turn-boot.txt" | cut -d: -f1 || true)"
SEED_REPLY_LINE="$(grep -n -m1 'mock response recovered' "$E2E_RUN_DIR/tui-turn-boot.txt" | cut -d: -f1 || true)"
if [[ -n "$SEED_USER_LINE" && -n "$SEED_REPLY_LINE" && "$SEED_USER_LINE" -ge "$SEED_REPLY_LINE" ]]; then
  echo "e2e: first user rendered after assistant reply (user=$SEED_USER_LINE assistant=$SEED_REPLY_LINE)" >&2
  exit 1
fi
echo "  first user/assistant order: API user=$SEED_USER_COUNT assistant=$SEED_ASSISTANT_COUNT"

BEFORE_COUNT="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message" | jq 'length')"
echo "== keyboard prompt =="
tmux send-keys -t "$E2E_TUI_SESSION" "e2e tui prompt: hello" Enter

NEW_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-turn-live.txt"
  local_turn_text="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if grep -qa "e2e tui prompt: hello" "$E2E_RUN_DIR/tui-turn-live.txt" \
    && [[ "$local_turn_text" == *"e2e tui prompt: hello"* && "$local_turn_text" == *"mock response recovered"* ]]; then
    NEW_HINT="user echoed and turn completed via API"
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

FINAL_HISTORY="$(curl -s "$TUI_URL/session/$TOOL_SESSION/message")"
FINAL_USER_COUNT="$(jq '[.[] | select(.info.role == "user")] | length' <<<"$FINAL_HISTORY")"
FINAL_ASSISTANT_COUNT="$(jq '[.[] | select(.info.role == "assistant")] | length' <<<"$FINAL_HISTORY")"
SEED_PROMPT_COUNT="$(jq '[.[] | select(.info.role == "user") | .parts[]?.text // empty | select(. == "e2e seed: tool session")] | length' <<<"$FINAL_HISTORY")"
KEYBOARD_PROMPT_COUNT="$(jq '[.[] | select(.info.role == "user") | .parts[]?.text // empty | select(. == "e2e tui prompt: hello")] | length' <<<"$FINAL_HISTORY")"
REPLY_COUNT="$(jq '[.[] | select(.info.role == "assistant") | .parts[]?.text // empty | select(. == "mock response recovered")] | length' <<<"$FINAL_HISTORY")"
FINAL_TOOL_COUNT="$(jq '[.. | objects | select(.type == "tool" and .tool == "bash")] | length' <<<"$FINAL_HISTORY")"
if [[ "$FINAL_USER_COUNT" != "2" || "$FINAL_ASSISTANT_COUNT" -le "$SEED_ASSISTANT_COUNT" \
  || "$SEED_PROMPT_COUNT" != "1" || "$KEYBOARD_PROMPT_COUNT" != "1" || "$REPLY_COUNT" != "2" \
  || "$FINAL_TOOL_COUNT" != "2" ]]; then
  echo "e2e: two-turn duplicate/order oracle failed (users=$FINAL_USER_COUNT assistants=$FINAL_ASSISTANT_COUNT seed=$SEED_PROMPT_COUNT keyboard=$KEYBOARD_PROMPT_COUNT replies=$REPLY_COUNT tools=$FINAL_TOOL_COUNT)" >&2
  exit 1
fi
e2e_tui_capture "$E2E_RUN_DIR/tui-turn-final.txt"
PANE_TOOL_COUNT="$(grep -Fc '$ echo dsh-oc-e2e-tool' "$E2E_RUN_DIR/tui-turn-final.txt" || true)"
if [[ "$PANE_TOOL_COUNT" != "2" ]]; then
  echo "e2e: real TUI rendered the two tool cards $PANE_TOOL_COUNT times (expected 2)" >&2
  exit 1
fi
echo "  two-turn history and real TUI each contain one copy of both tool calls"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-turn-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-turn-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks
if [[ ! -s "$MONITOR_LOG" ]]; then
  echo "e2e: exact attach PID monitor produced no samples (pid=$ATTACH_PID)" >&2
  exit 1
fi
echo "  observe-only monitor samples: pid=$ATTACH_PID log=$MONITOR_LOG"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-turn: PASSED in $((SECONDS - SCRIPT_START))s"
