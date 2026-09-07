#!/usr/bin/env bash
# Official OpenCode TUI shell-mode regression.  `!` is a TUI key binding that
# submits POST /session/:id/shell; it must execute through Agent maintenance
# and the owned OS shell process, rendering one tool card without an LLM turn.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""

cleanup() {
  local code=$?
  if (( code != 0 )) && tmux has-session -t "$E2E_TUI_SESSION" 2>/dev/null; then
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/tui-shell-cleanup.txt" 2>/dev/null || true
  fi
  e2e_tui_io_monitor_cleanup || true
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

e2e_new_run "tui-shell" "danger-full-access" "success" "1"
# Never reuse the branch-derived helper name: another e2e or developer may be
# using that tmux session concurrently.  This run owns only this exact name.
E2E_TUI_SESSION="dsh-oc-issue4-shell-$$"
E2E_ACTIVE_SESSION="$E2E_TUI_SESSION"

echo "== start official TUI in isolated tmux session $E2E_TUI_SESSION =="
echo "== create a dsh session before attaching the TUI =="
E2E_ACTIVE_SESSION="dsh-oc-issue4-shell-seed-$$"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SESSION="$(curl -s "$E2E_BRIDGE_URL/session" -X POST -H 'Content-Type: application/json' -d '{}' | jq -er '.id')"
echo "  session: $SESSION"
curl -s -X POST "$E2E_BRIDGE_URL/session/$SESSION/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"shell e2e seed"}]}' \
  | jq -e '.info.role == "assistant"' >/dev/null
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  if curl -s "$E2E_BRIDGE_URL/session/$SESSION/message" \
    | jq -e 'any(.. | objects; (.text // "") | contains("mock response recovered"))' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -s "$E2E_BRIDGE_URL/session/$SESSION/message" \
  | jq -e 'any(.. | objects; (.text // "") | contains("mock response recovered"))' >/dev/null 2>&1; then
  echo "e2e: seed reply not persisted before TUI attach" >&2
  exit 1
fi
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--session $SESSION"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"
LLM_REPLY_COUNT_BEFORE="$(curl -s "$TUI_URL/session/$SESSION/message" | grep -o 'mock response recovered' | wc -l | tr -d ' ')"

echo "== submit ! shell command =="
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  if tmux capture-pane -p -t "$E2E_TUI_SESSION" 2>/dev/null | grep -qa 'ctrl+p commands'; then
    break
  fi
  sleep 1
done
if ! tmux capture-pane -p -t "$E2E_TUI_SESSION" 2>/dev/null | grep -qa 'ctrl+p commands'; then
  echo "e2e: official TUI prompt did not become ready" >&2
  exit 1
fi

# Exercise the real official key binding. The literal `!` must be sent after
# the prompt is visible; S-1 would send `1` on some tmux versions.
tmux send-keys -t "$E2E_TUI_SESSION" -l '!'
deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  if tmux capture-pane -p -t "$E2E_TUI_SESSION" 2>/dev/null | grep -qa 'esc exit shell mode'; then
    break
  fi
  sleep 1
done
if ! tmux capture-pane -p -t "$E2E_TUI_SESSION" 2>/dev/null | grep -qa 'esc exit shell mode'; then
  echo "e2e: ! did not enter official shell mode" >&2
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" -l 'printf DSH_OC_SHELL_OK'
tmux send-keys -t "$E2E_TUI_SESSION" Enter

SHELL_CARD=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  SHELL_CARD="$(curl -s "$TUI_URL/session/$SESSION/message" | jq -c '[.. | objects | select(.type == "tool" and .tool == "bash") ] | last // {}' 2>/dev/null || true)"
  if jq -e '.state.status == "completed" and ((.state.output // "") | contains("DSH_OC_SHELL_OK"))' <<<"$SHELL_CARD" >/dev/null 2>&1; then
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited during shell mode: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if ! jq -e '.state.status == "completed" and ((.state.output // "") | contains("DSH_OC_SHELL_OK"))' <<<"$SHELL_CARD" >/dev/null 2>&1; then
  echo "e2e: completed bash card not returned by /message" >&2
  echo "$SHELL_CARD" >&2
  e2e_tui_capture "$E2E_RUN_DIR/tui-shell-failure.txt"
  tail -80 "$E2E_RUN_DIR/tui-shell-failure.txt" >&2 || true
  exit 1
fi
echo "  shell card completed in API history via the owned OS shell process"
BASH_CARD_COUNT="$(curl -s "$TUI_URL/session/$SESSION/message" | jq '[.. | objects | select(.type == "tool" and .tool == "bash")] | length')"
[[ "$BASH_CARD_COUNT" == 1 ]] || { echo "e2e: expected exactly one bash card, got $BASH_CARD_COUNT" >&2; exit 1; }
LLM_REPLY_COUNT_AFTER="$(curl -s "$TUI_URL/session/$SESSION/message" | grep -o 'mock response recovered' | wc -l | tr -d ' ')"
[[ "$LLM_REPLY_COUNT_AFTER" == "$LLM_REPLY_COUNT_BEFORE" ]] || {
  echo "e2e: shell unexpectedly triggered an LLM turn ($LLM_REPLY_COUNT_BEFORE -> $LLM_REPLY_COUNT_AFTER)" >&2
  exit 1
}

deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-shell.txt"
  grep -qa 'DSH_OC_SHELL_OK' "$E2E_RUN_DIR/tui-shell.txt" && break
  sleep 1
done
if ! grep -qa 'DSH_OC_SHELL_OK' "$E2E_RUN_DIR/tui-shell.txt"; then
  echo "e2e: shell output not visible in official TUI pane" >&2
  exit 1
fi
TUI_OUTPUT_COUNT="$(grep -aE '┃[[:space:]]+DSH_OC_SHELL_OK[[:space:]]*$' "$E2E_RUN_DIR/tui-shell.txt" | wc -l | tr -d ' ')"
[[ "$TUI_OUTPUT_COUNT" == 1 ]] || { echo "e2e: expected one TUI shell output, got $TUI_OUTPUT_COUNT" >&2; exit 1; }
echo "  official TUI rendered shell output"

e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
E2E_ACTIVE_SESSION=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-shell: PASSED in $((SECONDS - SCRIPT_START))s"
