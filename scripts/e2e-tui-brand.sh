#!/usr/bin/env bash
# Branding e2e: the real opencode TUI home screen shows the dsh-oc logo
# (figlet "DSH OC" + subtitle) instead of the OpenCode ASCII art.
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

e2e_new_run "tui-brand" "danger-full-access" "success" "1"

echo "== boot real opencode attach with dsh-oc branding plugin =="
e2e_tui_start ""
e2e_tui_wait_attach

BRAND_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-brand.txt"
  if grep -qa "DeepSeek Harness" "$E2E_RUN_DIR/tui-brand.txt" \
    || grep -qa "____  _____ __  __" "$E2E_RUN_DIR/tui-brand.txt"; then
    BRAND_HINT="dsh-oc logo"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for branded TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$BRAND_HINT" ]]; then
  echo "e2e: dsh-oc branding not visible in TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-brand.txt" >&2 || true
  exit 1
fi
echo "  branded logo visible: $BRAND_HINT"

if grep -qa "█▀▀█" "$E2E_RUN_DIR/tui-brand.txt"; then
  echo "e2e: original OpenCode ASCII logo still present" >&2
  exit 1
fi
echo "  original OpenCode logo absent"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-brand-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-brand-after.txt"; then
  echo "e2e: shell prompt not restored after branded TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-brand: PASSED in $((SECONDS - SCRIPT_START))s"
