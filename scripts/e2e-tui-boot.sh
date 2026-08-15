#!/usr/bin/env bash
# Real opencode TUI boot e2e: dsh --profile oc boots, spawns
# `opencode attach http://127.0.0.1:<port>`, the TUI renders, and a typed
# `exit` leaves dsh with code 0 and a cooked terminal.
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

e2e_new_run "tui-boot" "danger-full-access" "success" "1"

echo "== boot dsh + real opencode attach =="
e2e_tui_start ""
e2e_tui_wait_attach

if ps -eo args= | grep -q '/home/chiro/\.local/bin/opencode serve'; then
  echo "e2e: opencode serve must not run" >&2
  exit 1
fi
echo "  no opencode serve process"

TUI_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-boot.txt"
  for pattern in "Ask anything" "Mock Model" "DeepSeek" "opencode" "OpenCode" "ctrl+p" "agents" "1.18.18"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-boot.txt"; then
      TUI_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
echo "  pane bytes: $(wc -c < "$E2E_RUN_DIR/tui-boot.txt")"
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: no recognizable TUI text in pane capture" >&2
  exit 1
fi
echo "  TUI visible hint: \"$TUI_HINT\""

if grep -qaE 'Error|Unhandled|at .+\.tsx?[0-9]|stack trace' "$E2E_RUN_DIR/tui-boot.txt"; then
  echo "e2e: TUI pane contains error/stack text" >&2
  exit 1
fi

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-boot: PASSED in $((SECONDS - SCRIPT_START))s"
