#!/usr/bin/env bash
# Help-screen e2e: `dsh --profile oc --help` prints the dsh-oc capability
# summary and exits 0 without spawning the opencode TUI.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
cleanup() {
  local code=$?
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "tui-help" "danger-full-access" "success" "1"

echo "== run dsh --profile oc --help =="
set +e
(
  cd "$E2E_WORKDIR"
  export DSH_HOME="$E2E_DSH_HOME" DSH_PERMISSION_MODE="$E2E_PERMISSION_MODE" \
    DSH_OC_E2E_MOCK_API_KEY="$E2E_API_KEY" NO_PROXY=127.0.0.1,localhost
  timeout 45 dsh --profile oc --patch "$E2E_OVERLAY" --help
) > "$E2E_RUN_DIR/tui-help.txt" 2>&1
HELP_RC=$?
set -e
if [[ "$HELP_RC" != "0" ]]; then
  echo "e2e: expected dsh --help exit 0, got $HELP_RC" >&2
  tail -80 "$E2E_RUN_DIR/tui-help.txt" >&2 || true
  exit 1
fi
echo "  dsh exit: 0"

for pattern in "dsh-oc" "1.18.18" "核心能力" "--session/-s" "docs/FEATURES.md" "docs/PROTOCOL.md"; do
  if ! grep -qa -- "$pattern" "$E2E_RUN_DIR/tui-help.txt"; then
    echo "e2e: help output missing pattern: $pattern" >&2
    tail -80 "$E2E_RUN_DIR/tui-help.txt" >&2 || true
    exit 1
  fi
done
echo "  help output contains version/args/capability/docs"

node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-help: PASSED in $((SECONDS - SCRIPT_START))s"
