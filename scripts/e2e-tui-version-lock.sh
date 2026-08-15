#!/usr/bin/env bash
# Version-lock e2e: an explicitly configured opencode binary whose --version
# does not match OPENCODE_VERSION must be rejected before spawn, with a clear
# remediation message and a non-zero dsh exit.
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

e2e_new_run "tui-version-lock" "danger-full-access" "success" "1"

WRONG_BIN="$E2E_RUN_DIR/wrong-opencode"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${1:-}" in' \
  '  --version) printf "%s\\n" "0.0.0"; exit 0 ;;' \
  '  attach) exit 1 ;;' \
  'esac' \
  'exit 1' > "$WRONG_BIN"
chmod +x "$WRONG_BIN"

echo "== boot dsh with a version-mismatched explicit binary =="
e2e_tui_start "" "DSH_OC_OPENCODE_BIN='$WRONG_BIN' NO_PROXY=127.0.0.1,localhost"

deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then break; fi
  sleep 1
done
if [[ ! -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
  echo "e2e: dsh did not exit after version-mismatch" >&2
  exit 1
fi

EXIT_LINE="$(cat "$E2E_RUN_DIR/dsh-exit.txt")"
if [[ "$EXIT_LINE" != "DSH_EXIT=1" ]]; then
  echo "e2e: expected DSH_EXIT=1, got $EXIT_LINE" >&2
  exit 1
fi
echo "  dsh exit: $EXIT_LINE"

tmux capture-pane -p -S -300 -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/tui-version-lock.txt"
if ! grep -qa "reports version 0.0.0" "$E2E_RUN_DIR/tui-version-lock.txt" \
  || ! grep -qa "expected 1.18.18" "$E2E_RUN_DIR/tui-version-lock.txt" \
  || ! grep -qa "DSH_OC_OPENCODE_BIN" "$E2E_RUN_DIR/tui-version-lock.txt"; then
  echo "e2e: version-lock error message missing from pane" >&2
  tail -80 "$E2E_RUN_DIR/tui-version-lock.txt" >&2 || true
  exit 1
fi
echo "  version-lock error visible in pane"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-version-lock: PASSED in $((SECONDS - SCRIPT_START))s"
