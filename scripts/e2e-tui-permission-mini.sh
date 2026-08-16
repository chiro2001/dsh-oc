#!/usr/bin/env bash
# Minimal real-TUI permission case: one Allow-once cycle. Drives a single
# tool call that requests sandbox escalation, approves with Enter, then
# asserts the permission dialog is gone, the tool completed with output,
# exactly one reply rendered, and the session is idle. Kept to ~30s so the
# budgeted flake scan can repeat it 10x (round-0002 experiment 3).
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh
source tests/e2e/recovery-lib.sh

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

e2e_new_run "tui-permission-mini" "workspace-write" \
  "tool_call_success,success,success,success,success,success,success,success" "0"

# The escalation fields (sandbox_permissions) only exist in the standard
# preset; dsh settings override config defaults.
printf '\nagent-presets:\n  default: standard\n' >> "$E2E_DSH_HOME/settings.yaml"

echo "== boot real opencode TUI =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'permission mini allow once' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

echo "== wait for the permission dialog =="
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  local_pending="$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length' 2>/dev/null || echo 0)"
  e2e_tui_capture "$E2E_RUN_DIR/perm-dialog.txt"
  if [[ "$local_pending" != "0" ]] \
    && grep -qa 'Permission required' "$E2E_RUN_DIR/perm-dialog.txt" \
    && grep -qa 'Allow once' "$E2E_RUN_DIR/perm-dialog.txt"; then
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for permission dialog" >&2
    exit 1
  fi
  sleep 1
done
if (( SECONDS >= deadline )); then
  echo "e2e: permission dialog did not appear" >&2
  tail -30 "$E2E_RUN_DIR/perm-dialog.txt" >&2 || true
  exit 1
fi
echo "  dialog shown; approving once"
tmux send-keys -t "$E2E_TUI_SESSION" Enter

recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"

echo "== exactly-once and tool assertions =="
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/final-v1.json" "$E2E_RUN_DIR/final-v2.json"

if ! jq -e '
    ([ .[] | select(.type == "assistant") | .parts[]
      | select(.type == "text" and .text == "mock response recovered") ] | length) == 1
    and ([ .[] | select(.type == "assistant") | .parts[]
      | select(.type == "tool" and .status == "completed" and (.text | length) > 0) ] | length) == 1
  ' "$E2E_RUN_DIR/final-v2.json" >/dev/null; then
  echo "e2e: permission mini reply/tool assertions failed" >&2
  cat "$E2E_RUN_DIR/final-v2.json" >&2
  exit 1
fi
if [[ "$(curl -s "$E2E_BRIDGE_URL/permission" | jq 'length')" != "0" ]]; then
  echo "e2e: permission dialog still pending after approve" >&2
  exit 1
fi
echo "  exactly one reply and one completed tool, no pending permission"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-permission-mini: PASSED in $((SECONDS - SCRIPT_START))s"
