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
PRESET_RESULT_SEEN=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-preset-cmd.txt"
  if grep -qa 'Switched dsh agent preset to minimal' "$E2E_RUN_DIR/tui-preset-cmd.txt" \
    || grep -qa 'preset switched to minimal' "$E2E_RUN_DIR/tui-preset-cmd.txt"; then
    PRESET_RESULT_SEEN="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited before /preset result rendered: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$PRESET_RESULT_SEEN" ]]; then
  echo "e2e: /preset minimal result not rendered in the TUI" >&2
  tail -40 "$E2E_RUN_DIR/tui-preset-cmd.txt" >&2 || true
  exit 1
fi
# A final synthetic command assistant must carry time.completed. Without it,
# the official TUI incorrectly labels the preceding "preset switched" card
# QUEUED until another user prompt closes the turn (issue #5).
if grep -qa 'QUEUED' "$E2E_RUN_DIR/tui-preset-cmd.txt"; then
  echo "e2e: /preset switch card is still marked QUEUED" >&2
  tail -40 "$E2E_RUN_DIR/tui-preset-cmd.txt" >&2 || true
  exit 1
fi
echo "  /preset minimal result rendered without a stale QUEUED badge"

# The blank session is created lazily by the TUI and may not be listed until
# the first command has completed. Resolve it now for the model comparison.
PRESET_SESSION="$(e2e_curl -s "$E2E_BRIDGE_URL/session" \
  | jq -r 'map(select(.agent == "minimal")) | .[0].id // empty')"
if [[ -z "$PRESET_SESSION" ]]; then
  # A host list refresh can lag the live session.updated edge; the newest
  # listed session is still a safe fallback in this fresh per-run profile.
  PRESET_SESSION="$(e2e_curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[-1].id // empty')"
fi
if [[ -z "$PRESET_SESSION" ]]; then
  echo "e2e: could not identify the TUI session after /preset" >&2
  exit 1
fi
# Compare the final completed command assistant, not the preceding user echo.
# Filter by the exact result text so a seeded history page cannot make an old
# completed msg_cmd look like the current /preset result.
SESSION_JSON="$(e2e_curl -s "$E2E_BRIDGE_URL/api/session/$PRESET_SESSION")"
SESSION_MODEL="$(jq -r '.data.model.id // empty' <<<"$SESSION_JSON")"
SESSION_PROVIDER="$(jq -r '.data.model.providerID // empty' <<<"$SESSION_JSON")"
PRESET_MESSAGES="$(e2e_curl -s "$E2E_BRIDGE_URL/session/$PRESET_SESSION/message")"
PRESET_COMMAND="$(jq -c '
  [ .[]
    | select((.info.id // "") | startswith("msg_cmd:"))
    | select(.info.time.completed != null)
    | select(([.parts[]? | select(.type == "text") | .text] | join("\n"))
      | contains("Switched dsh agent preset to minimal"))
  ] | last // {}
' <<<"$PRESET_MESSAGES")"
PRESET_MODEL="$(jq -r '.info.modelID // empty' <<<"$PRESET_COMMAND")"
PRESET_PROVIDER="$(jq -r '.info.providerID // empty' <<<"$PRESET_COMMAND")"
if [[ -z "$SESSION_MODEL" || -z "$PRESET_MODEL" || "$SESSION_MODEL" != "$PRESET_MODEL" \
  || "$SESSION_PROVIDER" != "$PRESET_PROVIDER" ]]; then
  echo "e2e: final completed /preset command model differs from session model" >&2
  echo "  session=$SESSION_PROVIDER/$SESSION_MODEL command=$PRESET_PROVIDER/$PRESET_MODEL" >&2
  exit 1
fi
echo "  final completed /preset command model matches session: $PRESET_PROVIDER/$PRESET_MODEL"

# The visible pane must show the actual mock model and must not show the
# bridge's historical deepseek-chat fallback. These assertions are kept on
# the current capture and therefore cannot pass from unrelated seeded rows.
if ! grep -Eqa 'mock-model|Mock Model' "$E2E_RUN_DIR/tui-preset-cmd.txt"; then
  echo "e2e: TUI /preset pane did not display the mock-model label" >&2
  tail -60 "$E2E_RUN_DIR/tui-preset-cmd.txt" >&2 || true
  exit 1
fi
if grep -qa 'deepseek-chat' "$E2E_RUN_DIR/tui-preset-cmd.txt"; then
  echo "e2e: TUI /preset pane displayed stale deepseek-chat" >&2
  tail -60 "$E2E_RUN_DIR/tui-preset-cmd.txt" >&2 || true
  exit 1
fi
echo "  TUI /preset pane shows Mock Model (mock-model) without deepseek-chat"

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
