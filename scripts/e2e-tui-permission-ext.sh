#!/usr/bin/env bash
# Real TUI permission e2e, extended keyboard surface: question option
# navigation (Down + ANSI highlight), question Esc cancel, and permission
# dialog Esc (which opencode maps to reject), in both standard and mini TUIs.
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

e2e_tui_capture_ansi() {
  tmux capture-pane -p -e -t "$E2E_TUI_SESSION" > "$1" || true
}

wait_tui_ready() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    e2e_tui_capture_ansi "$E2E_RUN_DIR/tui-ready.txt"
    if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt"; then
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited while waiting for TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  echo "e2e: TUI did not render" >&2
  tail -40 "$E2E_RUN_DIR/tui-ready.txt" >&2 || true
  return 1
}

wait_question_dialog() {
  local file="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local pending
    pending="$(curl -s "$E2E_BRIDGE_URL/question" | jq 'length' 2>/dev/null || echo 0)"
    e2e_tui_capture_ansi "$file"
    if [[ "$pending" != "0" ]] && grep -qa 'Pick a language' "$file"; then
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited while waiting for question dialog" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  echo "e2e: question dialog did not appear" >&2
  tail -40 "$file" >&2 || true
  return 1
}

wait_permission_dialog() {
  local file="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local pending
    pending="$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 0)"
    e2e_tui_capture_ansi "$file"
    if [[ "$pending" != "0" ]] && grep -qa 'Permission required' "$file" && grep -qa 'Allow once' "$file"; then
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited while waiting for permission dialog" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  echo "e2e: permission dialog did not appear" >&2
  tail -40 "$file" >&2 || true
  return 1
}

wait_reply_count() {
  local sid="$1"
  local n="$2"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$E2E_BRIDGE_URL/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$(grep -o 'mock response recovered' <<<"$text" | wc -l)" -ge "$n" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: reply count $n not seen on $sid" >&2
  curl -s "$E2E_BRIDGE_URL/session/$sid/message" >&2 || true
  return 1
}

active_session_id() {
  curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty'
}

start_tui_turn() {
  local input="$1"
  local sid=""
  tmux send-keys -t "$E2E_TUI_SESSION" "$input" Enter
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    sid="$(active_session_id)"
    if [[ -n "$sid" ]]; then break; fi
    sleep 1
  done
  [[ -n "$sid" ]]
  echo "$sid"
}

option_has_highlight() {
  local file="$1"
  local label="$2"
  grep -a "$label" "$file" | head -1 | grep -aq '38;2;106;145;198'
}

echo "== run H: standard question navigation + Esc cancel =="
e2e_new_run "tui-permission-nav" "workspace-write" \
  "tool_call_success,success,success,tool_call_success,success,success" "0" \
  '{"questions":[{"id":"q1","question":"Pick a language?","options":[{"label":"Python"},{"label":"Node.js"}]}]}' \
  "ask_user_question"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

SID="$(start_tui_turn 'ask a question')"
echo "  session $SID"
wait_question_dialog "$E2E_RUN_DIR/nav-baseline.txt"
if ! option_has_highlight "$E2E_RUN_DIR/nav-baseline.txt" 'Python'; then
  echo "e2e: first option not highlighted on baseline" >&2
  exit 1
fi
if option_has_highlight "$E2E_RUN_DIR/nav-baseline.txt" 'Node.js'; then
  echo "e2e: second option unexpectedly highlighted on baseline" >&2
  exit 1
fi
echo "  baseline highlight on Python"

tmux send-keys -t "$E2E_TUI_SESSION" Down
sleep 1
e2e_tui_capture_ansi "$E2E_RUN_DIR/nav-down.txt"
if ! option_has_highlight "$E2E_RUN_DIR/nav-down.txt" 'Node.js'; then
  echo "e2e: Down did not move the highlight to Node.js" >&2
  exit 1
fi
if option_has_highlight "$E2E_RUN_DIR/nav-down.txt" 'Python'; then
  echo "e2e: Python still highlighted after Down" >&2
  exit 1
fi
echo "  Down moved highlight to Node.js"

tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_reply_count "$SID" 1
curl -s "$E2E_BRIDGE_URL/question" | jq -e 'length == 0' >/dev/null
e2e_tui_capture_ansi "$E2E_RUN_DIR/nav-answered.txt"
grep -qa 'mock response recovered' "$E2E_RUN_DIR/nav-answered.txt"
echo "  second option answered; /question empty; reply rendered"

SID="$(start_tui_turn 'ask again')"
echo "  session $SID"
wait_question_dialog "$E2E_RUN_DIR/nav-esc-before.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Escape
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if [[ "$(curl -s "$E2E_BRIDGE_URL/question" | jq 'length' 2>/dev/null || echo 1)" == "0" ]]; then
    break
  fi
  sleep 1
done
curl -s "$E2E_BRIDGE_URL/question" | jq -e 'length == 0' >/dev/null
echo "  question Esc cancelled; /question empty"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run I: standard permission Esc = reject =="
e2e_new_run "tui-permission-esc" "workspace-write" "tool_call_success,success,success" "1" \
  '{"file_path":"@WORKDIR@/reject.txt","old_string":"a","new_string":"b","sandbox_permissions":"danger-full-access","justification":"e2e esc reject"}' \
  "edit"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

SID="$(start_tui_turn 'permission esc')"
echo "  session $SID"
wait_permission_dialog "$E2E_RUN_DIR/esc-perm-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Escape
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if [[ "$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 1)" == "0" ]]; then
    break
  fi
  sleep 1
done
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
wait_reply_count "$SID" 1
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
if jq -e --arg s "$SID" '.data | any(.sessionID == $s and (.id | endswith(":edit")))' <<<"$SAVED" >/dev/null; then
  echo "e2e: Esc unexpectedly saved an edit grant" >&2
  exit 1
fi
if [[ -e "$E2E_WORKDIR/reject.txt" ]]; then
  echo "e2e: Esc-rejected edit still wrote the file" >&2
  exit 1
fi
e2e_tui_capture_ansi "$E2E_RUN_DIR/esc-perm-reply.txt"
tmux capture-pane -p -S -300 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/esc-perm-scrollback.txt" 2>/dev/null || true
if ! grep -qia 'rejected' "$E2E_RUN_DIR/esc-perm-reply.txt" \
  && ! grep -qia 'rejected' "$E2E_RUN_DIR/esc-perm-scrollback.txt" \
  && ! grep -qa '← Edit reject.txt' "$E2E_RUN_DIR/esc-perm-reply.txt" \
  && ! grep -qa '← Edit reject.txt' "$E2E_RUN_DIR/esc-perm-scrollback.txt" \
  && ! grep -qa '# Edited reject.txt' "$E2E_RUN_DIR/esc-perm-reply.txt" \
  && ! grep -qa '# Edited reject.txt' "$E2E_RUN_DIR/esc-perm-scrollback.txt"; then
  echo "e2e: Esc rejection result not visible in TUI" >&2
  tail -40 "$E2E_RUN_DIR/esc-perm-reply.txt" >&2 || true
  exit 1
fi
echo "  permission Esc rejected; error visible; file not written; turn completed"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run J: mini question Esc cancel =="
e2e_new_run "tui-permission-mini-esc-question" "workspace-write" \
  "tool_call_success,success,success" "0" \
  '{"questions":[{"id":"q1","question":"Pick a language?","options":[{"label":"Python"},{"label":"Node.js"}]}]}' \
  "ask_user_question"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

SID="$(start_tui_turn 'mini ask a question')"
echo "  session $SID"
wait_question_dialog "$E2E_RUN_DIR/mini-esc-q-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Escape
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if [[ "$(curl -s "$E2E_BRIDGE_URL/question" | jq 'length' 2>/dev/null || echo 1)" == "0" ]]; then
    break
  fi
  sleep 1
done
curl -s "$E2E_BRIDGE_URL/question" | jq -e 'length == 0' >/dev/null
echo "  mini question Esc cancelled; /question empty"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run K: mini permission Esc = reject =="
e2e_new_run "tui-permission-mini-esc" "workspace-write" "tool_call_success,success,success" "1" \
  '{"file_path":"@WORKDIR@/reject.txt","old_string":"a","new_string":"b","sandbox_permissions":"danger-full-access","justification":"e2e mini esc reject"}' \
  "edit"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

SID="$(start_tui_turn 'mini permission esc')"
echo "  session $SID"
wait_permission_dialog "$E2E_RUN_DIR/mini-esc-perm-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 2
e2e_tui_capture_ansi "$E2E_RUN_DIR/mini-esc-perm-confirm.txt"
if ! grep -qa 'Reject permission' "$E2E_RUN_DIR/mini-esc-perm-confirm.txt"; then
  echo "e2e: mini Esc did not open the Reject permission layer" >&2
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" Enter
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if [[ "$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 1)" == "0" ]]; then
    break
  fi
  sleep 1
done
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
wait_reply_count "$SID" 1
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
if jq -e --arg s "$SID" '.data | any(.sessionID == $s and (.id | endswith(":edit")))' <<<"$SAVED" >/dev/null; then
  echo "e2e: mini Esc unexpectedly saved an edit grant" >&2
  exit 1
fi
if [[ -e "$E2E_WORKDIR/reject.txt" ]]; then
  echo "e2e: mini Esc-rejected edit still wrote the file" >&2
  exit 1
fi
e2e_tui_capture_ansi "$E2E_RUN_DIR/mini-esc-perm-reply.txt"
tmux capture-pane -p -S -300 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/mini-esc-perm-scrollback.txt" 2>/dev/null || true
if ! grep -qia 'rejected' "$E2E_RUN_DIR/mini-esc-perm-reply.txt" \
  && ! grep -qia 'rejected' "$E2E_RUN_DIR/mini-esc-perm-scrollback.txt" \
  && ! grep -qa '← Edit reject.txt' "$E2E_RUN_DIR/mini-esc-perm-reply.txt" \
  && ! grep -qa '← Edit reject.txt' "$E2E_RUN_DIR/mini-esc-perm-scrollback.txt" \
  && ! grep -qa '# Edited reject.txt' "$E2E_RUN_DIR/mini-esc-perm-reply.txt" \
  && ! grep -qa '# Edited reject.txt' "$E2E_RUN_DIR/mini-esc-perm-scrollback.txt"; then
  echo "e2e: mini Esc rejection result not visible in TUI" >&2
  exit 1
fi
echo "  mini permission Esc rejected; error visible; file not written; turn completed"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "e2e-tui-permission-ext: PASSED in $((SECONDS - SCRIPT_START))s"
