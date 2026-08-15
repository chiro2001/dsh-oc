#!/usr/bin/env bash
# Skill slash-command e2e: DSH_OC_E2E_FAKE_SKILLS injects a fake skill into
# the bridge; the real TUI types /code-review and the bridge API confirms a
# model turn containing the command and the mock reply.
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

e2e_new_run "tui-skill" "danger-full-access" "success" "1"

echo "== boot real opencode attach with a fake skill =="
e2e_tui_start "" "DSH_OC_E2E_FAKE_SKILLS=code-review"
e2e_tui_wait_attach

READY_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-skill-ready.txt"
  if grep -qa "Ask anything" "$E2E_RUN_DIR/tui-skill-ready.txt"; then
    READY_HINT="Ask anything"
    break
  fi
  sleep 1
done
if [[ -z "$READY_HINT" ]]; then
  echo "e2e: TUI did not become ready for skill input" >&2
  exit 1
fi
echo "  TUI ready: $READY_HINT"

echo "== type /code-review with per-key pacing =="
tmux send-keys -t "$E2E_TUI_SESSION" "/code-review"
sleep 2
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Enter

SKILL_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  for sid in $(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[].id'); do
    local_text="$(curl -s "$E2E_BRIDGE_URL/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$local_text" == *"code-review"* && "$local_text" == *"mock response recovered"* ]]; then
      SKILL_HINT="code-review + mock reply"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for skill reply: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$SKILL_HINT" ]]; then
  echo "e2e: /code-review did not produce a model turn" >&2
  echo "e2e: sessions: $(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[].id')" >&2
  for sid in $(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[].id'); do
    echo "--- $sid" >&2
    curl -s "$E2E_BRIDGE_URL/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null | head -c 400 >&2 || true
    echo >&2
  done
  e2e_tui_capture "$E2E_RUN_DIR/tui-skill-fail.txt"
  tail -30 "$E2E_RUN_DIR/tui-skill-fail.txt" >&2 || true
  exit 1
fi
echo "  skill prompt produced a reply: $SKILL_HINT"

echo "== stop the skill TUI harness =="
e2e_stop_dsh "$E2E_TUI_SESSION"
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-skill: PASSED in $((SECONDS - SCRIPT_START))s"
