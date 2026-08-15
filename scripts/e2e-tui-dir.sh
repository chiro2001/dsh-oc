#!/usr/bin/env bash
# Attach --dir e2e: dsh --profile oc --dir <subdir> boots the real opencode
# TUI with that working directory (visible in the footer/pane) and exits
# cleanly.
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

e2e_new_run "tui-dir" "danger-full-access" "success" "1"

mkdir -p "$E2E_WORKDIR/sub-project"
SUB_DIR="sub-project"

echo "== boot real opencode attach with --dir =="
e2e_tui_start "--dir $SUB_DIR"
e2e_tui_wait_attach

DIR_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-dir.txt"
  if grep -qa "sub-project" "$E2E_RUN_DIR/tui-dir.txt"; then
    DIR_HINT="sub-project"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for --dir TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$DIR_HINT" ]]; then
  echo "e2e: --dir working directory not visible in TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-dir.txt" >&2 || true
  exit 1
fi
echo "  --dir visible in pane: $DIR_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-dir-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-dir-after.txt"; then
  echo "e2e: shell prompt not restored after --dir TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-dir: PASSED in $((SECONDS - SCRIPT_START))s"
