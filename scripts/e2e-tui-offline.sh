#!/usr/bin/env bash
# Offline TUI boot e2e: with HTTPS_PROXY/HTTP_PROXY pointed at an unreachable
# port and the dsh-oc opencode cache removed, the real TUI must still boot in
# time using the locked binary and must not need the opencode update path.
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

e2e_new_run "tui-offline" "danger-full-access" "success" "1"

# Simulate a machine with no dsh-oc-managed opencode cache. The resolver must
# still find the locked PATH binary without touching the network.
for dir in bin packages cache; do
  rm -rf "$E2E_DSH_HOME/opencode/$dir"
done

echo "== boot real opencode attach with unreachable proxy =="
OFFLINE_ENV="HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost"
e2e_tui_start "" "$OFFLINE_ENV"
e2e_tui_wait_attach

TUI_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-offline.txt"
  for pattern in "Ask anything" "Mock Model" "DeepSeek" "opencode" "OpenCode" "1.18.18"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-offline.txt"; then
      TUI_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for offline TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$TUI_HINT" ]]; then
  echo "e2e: no recognizable TUI text in offline pane capture" >&2
  tail -60 "$E2E_RUN_DIR/tui-offline.txt" >&2 || true
  exit 1
fi
echo "  offline TUI visible hint: \"$TUI_HINT\""

if grep -qaE 'Error|Unhandled|stack trace' "$E2E_RUN_DIR/tui-offline.txt"; then
  echo "e2e: offline TUI pane contains error/stack text" >&2
  exit 1
fi

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-offline-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-offline-after.txt"; then
  echo "e2e: shell prompt not restored after offline TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-offline: PASSED in $((SECONDS - SCRIPT_START))s"
