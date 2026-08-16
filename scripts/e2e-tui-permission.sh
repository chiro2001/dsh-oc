#!/usr/bin/env bash
# Real TUI permission e2e: with DSH_PERMISSION_MODE=workspace-write the mock
# LLM issues tool calls that request sandbox escalation, so the opencode TUI
# must show the permission dialog. Covers Allow once, Allow always + saved
# grant + auto-approve, Reject, and the ask_user_question dialog.
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
  # The escalation fields (sandbox_permissions) and ask_user_question only
  # exist in the standard preset; dsh settings override config defaults.
  printf '\nagent-presets:\n  default: standard\n' >> "$E2E_DSH_HOME/settings.yaml"
}

wait_tui_ready() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
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

wait_permission_dialog() {
  local bridge="$1"
  local file="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local pending
    pending="$(curl -s "$bridge/permission" | jq 'length' 2>/dev/null || echo 0)"
    e2e_tui_capture "$file"
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
  echo "--- mock log tail ---" >&2
  tail -8 "$E2E_MOCK_ERR" >&2 2>/dev/null || true
  return 1
}

wait_reply_count() {
  local bridge="$1"
  local sid="$2"
  local n="$3"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$bridge/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$(grep -o 'mock response recovered' <<<"$text" | wc -l)" -ge "$n" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: reply count $n not seen on $sid" >&2
  curl -s "$bridge/session/$sid/message" >&2 || true
  return 1
}

active_session_id() {
  local bridge="$1"
  curl -s "$bridge/session" | jq -r '.[0].id // empty'
}

echo "== run A: allow once / allow always / auto-approve =="
# Three consecutive tool calls drive the once -> always -> auto-approve
# dialogs; keep extra tool calls + success slots for slow runners.
e2e_new_run "tui-permission" "workspace-write" \
  "tool_call_success,tool_call_success,tool_call_success,tool_call_success,tool_call_success,tool_call_success,tool_call_success,tool_call_success,success,success,success,success,success,success,success,success,success,success,success,success" "0"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'permission once' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-once-dialog.txt"
echo "  dialog 1 shown (once)"
tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-always-dialog.txt"
echo "  dialog 2 shown (always)"
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Enter
sleep 1
e2e_tui_capture "$E2E_RUN_DIR/perm-always-confirm.txt"
if grep -qa 'This will allow\|Confirm' "$E2E_RUN_DIR/perm-always-confirm.txt"; then
  tmux send-keys -t "$E2E_TUI_SESSION" Enter
  sleep 1
fi
AUTO_OK="1"
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  local_count="$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 1)"
  if [[ "$local_count" != "0" ]]; then
    AUTO_OK=""
    break
  fi
  local_text="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$(grep -o 'mock response recovered' <<<"$local_text" | wc -l)" -ge 1 ]]; then
    break
  fi
  sleep 0.3
done
if [[ -z "$AUTO_OK" ]]; then
  echo "e2e: third tool call raised a new permission (expected auto-approve)" >&2
  exit 1
fi
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
jq -e --arg s "$SID" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED" >/dev/null
echo "  allow once + allow always + auto-approve verified; bash grant saved"

tmux send-keys -t "$E2E_TUI_SESSION" 'permission after always' Enter
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 2
echo "  third tool call auto-approved without a dialog"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run B: reject =="
e2e_new_run "tui-permission-reject" "workspace-write" "tool_call_success,success" "1" \
  '{"file_path":"@WORKDIR@/reject.txt","old_string":"a","new_string":"b","sandbox_permissions":"danger-full-access","justification":"e2e reject flow"}' \
  "edit"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'permission reject' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-reject-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
if jq -e --arg s "$SID" '.data | any(.sessionID == $s and (.id | endswith(":edit")))' <<<"$SAVED" >/dev/null; then
  echo "e2e: reject unexpectedly saved an edit grant" >&2
  exit 1
fi
echo "  reject cleared permission; no saved grant"

e2e_tui_capture "$E2E_RUN_DIR/perm-reject-result.txt"
tmux capture-pane -p -S -300 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/perm-reject-scrollback.txt" 2>/dev/null || true
REJECT_MSG="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '.. | strings | select(test("reject"; "i"))' 2>/dev/null | head -1 || true)"
if ! grep -qia 'rejected' "$E2E_RUN_DIR/perm-reject-result.txt" \
  && ! grep -qia 'rejected' "$E2E_RUN_DIR/perm-reject-scrollback.txt" \
  && [[ -z "$REJECT_MSG" ]]; then
  echo "e2e: rejection result not visible in TUI nor bridge messages" >&2
  tail -40 "$E2E_RUN_DIR/perm-reject-result.txt" >&2 || true
  exit 1
fi
echo "  TUI/bridge shows the rejected result"
if [[ -e "$E2E_WORKDIR/reject.txt" ]]; then
  echo "e2e: rejected edit still wrote the file" >&2
  exit 1
fi
echo "  rejected edit did not write the file"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run C: ask_user_question dialog =="
e2e_new_run "tui-permission-question" "workspace-write" "tool_call_success,success" "1" \
  '{"questions":[{"id":"q1","question":"Pick a language?","options":[{"label":"Python"},{"label":"Node.js"}]}]}' \
  "ask_user_question"
use_standard_preset
e2e_tui_start ""
e2e_tui_wait_attach
wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'ask me a question' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

QUESTION_SEEN=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  QLEN="$(curl -s "$E2E_BRIDGE_URL/question" | jq 'length' 2>/dev/null || echo 0)"
  e2e_tui_capture "$E2E_RUN_DIR/question-dialog.txt"
  if [[ "$QLEN" != "0" ]] && grep -qa 'Pick a language' "$E2E_RUN_DIR/question-dialog.txt"; then
    QUESTION_SEEN="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for question dialog" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$QUESTION_SEEN" ]]; then
  echo "e2e: question dialog did not appear" >&2
  tail -40 "$E2E_RUN_DIR/question-dialog.txt" >&2 || true
  exit 1
fi
echo "  question dialog shown"

tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/question" | jq -e 'length == 0' >/dev/null
e2e_tui_capture "$E2E_RUN_DIR/question-answered.txt"
grep -qa 'mock response recovered' "$E2E_RUN_DIR/question-answered.txt"
echo "  question answered; /question empty; turn completed"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run D: mini permission dialog =="
e2e_new_run "tui-permission-mini" "workspace-write" "tool_call_success,success" "1"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'mini permission once' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-mini-dialog.txt"
echo "  mini permission dialog shown"
tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-reply.txt"
REPLY_COUNT="$(grep -o 'mock response recovered' "$E2E_RUN_DIR/perm-mini-reply.txt" | wc -l)"
if [[ "$REPLY_COUNT" != "1" ]]; then
  echo "e2e: mini rendered the reply $REPLY_COUNT times (expected 1)" >&2
  exit 1
fi
echo "  mini allow once completed; reply rendered once"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run E: mini allow always + auto-approve =="
e2e_new_run "tui-permission-mini-always" "workspace-write" "tool_call_success,tool_call_success,tool_call_success,success" "1"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'mini permission always' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-mini-always-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Enter
sleep 1
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-always-confirm.txt"
if grep -qa 'This will allow\|Confirm' "$E2E_RUN_DIR/perm-mini-always-confirm.txt"; then
  tmux send-keys -t "$E2E_TUI_SESSION" Enter
  sleep 1
fi
AUTO_OK="1"
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  local_count="$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 1)"
  if [[ "$local_count" != "0" ]]; then
    AUTO_OK=""
    break
  fi
  local_text="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$(grep -o 'mock response recovered' <<<"$local_text" | wc -l)" -ge 1 ]]; then
    break
  fi
  sleep 0.3
done
if [[ -z "$AUTO_OK" ]]; then
  echo "e2e: mini third tool call raised a new permission (expected auto-approve)" >&2
  exit 1
fi
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
jq -e --arg s "$SID" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED" >/dev/null
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-always-reply.txt"
REPLY_COUNT="$(grep -o 'mock response recovered' "$E2E_RUN_DIR/perm-mini-always-reply.txt" | wc -l)"
if [[ "$REPLY_COUNT" != "1" ]]; then
  echo "e2e: mini always rendered the reply $REPLY_COUNT times (expected 1)" >&2
  exit 1
fi
echo "  mini allow always + auto-approve verified; reply rendered once"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run F: mini reject =="
e2e_new_run "tui-permission-mini-reject" "workspace-write" "tool_call_success,success" "1" \
  '{"file_path":"@WORKDIR@/reject.txt","old_string":"a","new_string":"b","sandbox_permissions":"danger-full-access","justification":"e2e mini reject"}' \
  "edit"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'mini permission reject' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

wait_permission_dialog "$E2E_BRIDGE_URL" "$E2E_RUN_DIR/perm-mini-reject-dialog.txt"
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Right
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Enter
sleep 1
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-reject-confirm.txt"
if grep -qa 'Reject permission\|Confirm' "$E2E_RUN_DIR/perm-mini-reject-confirm.txt"; then
  if [[ "$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 0)" != "0" ]]; then
    tmux send-keys -t "$E2E_TUI_SESSION" Enter
    sleep 1
  fi
fi
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/permission" | jq -e 'length == 0' >/dev/null
SAVED="$(curl -s "$E2E_BRIDGE_URL/api/permission/saved")"
if jq -e --arg s "$SID" '.data | any(.sessionID == $s and (.id | endswith(":edit")))' <<<"$SAVED" >/dev/null; then
  echo "e2e: mini reject unexpectedly saved an edit grant" >&2
  exit 1
fi
if [[ -e "$E2E_WORKDIR/reject.txt" ]]; then
  echo "e2e: mini rejected edit still wrote the file" >&2
  exit 1
fi
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-reject-reply.txt"
tmux capture-pane -p -S -300 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/perm-mini-reject-scrollback.txt" 2>/dev/null || true
REJECT_MSG="$(curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq -r '.. | strings | select(test("reject"; "i"))' 2>/dev/null | head -1 || true)"
if ! grep -qia 'rejected' "$E2E_RUN_DIR/perm-mini-reject-reply.txt" \
  && ! grep -qia 'rejected' "$E2E_RUN_DIR/perm-mini-reject-scrollback.txt" \
  && [[ -z "$REJECT_MSG" ]]; then
  echo "e2e: mini rejection result not visible in TUI nor bridge messages" >&2
  exit 1
fi
echo "  mini reject cleared permission; error visible; file not written"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "== run G: mini ask_user_question dialog =="
e2e_new_run "tui-permission-mini-question" "workspace-write" "tool_call_success,success" "1" \
  '{"questions":[{"id":"q1","question":"Pick a language?","options":[{"label":"Python"},{"label":"Node.js"}]}]}' \
  "ask_user_question"
use_standard_preset
e2e_tui_start "--mini"
e2e_tui_wait_attach
wait_tui_ready
echo "  mini TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'mini ask a question' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(active_session_id "$E2E_BRIDGE_URL")"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

QUESTION_SEEN=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  QLEN="$(curl -s "$E2E_BRIDGE_URL/question" | jq 'length' 2>/dev/null || echo 0)"
  e2e_tui_capture "$E2E_RUN_DIR/perm-mini-question-dialog.txt"
  if [[ "$QLEN" != "0" ]] && grep -qa 'Pick a language' "$E2E_RUN_DIR/perm-mini-question-dialog.txt"; then
    QUESTION_SEEN="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for mini question dialog" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$QUESTION_SEEN" ]]; then
  echo "e2e: mini question dialog did not appear" >&2
  tail -40 "$E2E_RUN_DIR/perm-mini-question-dialog.txt" >&2 || true
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" Enter
wait_reply_count "$E2E_BRIDGE_URL" "$SID" 1
curl -s "$E2E_BRIDGE_URL/question" | jq -e 'length == 0' >/dev/null
e2e_tui_capture "$E2E_RUN_DIR/perm-mini-question-reply.txt"
REPLY_COUNT="$(grep -o 'mock response recovered' "$E2E_RUN_DIR/perm-mini-question-reply.txt" | wc -l)"
if [[ "$REPLY_COUNT" != "1" ]]; then
  echo "e2e: mini question rendered the reply $REPLY_COUNT times (expected 1)" >&2
  exit 1
fi
echo "  mini question answered; /question empty; reply rendered once"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
E2E_RUNID=""

echo "e2e-tui-permission: PASSED in $((SECONDS - SCRIPT_START))s"
