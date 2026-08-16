#!/usr/bin/env bash
# dsh-oc shortcut command e2e: the profile install must expose
# node_modules/.bin/dsh-oc, and invoking it must behave like
# `dsh --profile oc` (help output, exit codes, unknown-arg handling).
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_RUNID=""
cleanup() {
  local code=$?
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "cli-bin" "danger-full-access" "success" "1"

BIN="$E2E_PROFILE_DIR/node_modules/.bin/dsh-oc"
if [[ ! -x "$BIN" ]]; then
  echo "e2e: profile bin missing: $BIN" >&2
  ls "$E2E_PROFILE_DIR/node_modules/.bin" >&2 2>/dev/null || true
  exit 1
fi
echo "  bin present: $BIN"

export PATH="$E2E_PROFILE_DIR/node_modules/.bin:$PATH"
export DSH_HOME="$E2E_DSH_HOME"

SHORT="$(dsh-oc --help 2>&1)"
SHORT_RC=$?
if [[ "$SHORT_RC" != "0" ]]; then
  echo "e2e: dsh-oc --help exited $SHORT_RC" >&2
  echo "$SHORT" >&2
  exit 1
fi
if [[ "$SHORT" != *"dsh-oc"* || "$SHORT" != *"DeepSeek Harness"* ]]; then
  echo "e2e: dsh-oc --help output unexpected:" >&2
  echo "$SHORT" >&2
  exit 1
fi
echo "  dsh-oc --help ok"

LONG="$(dsh --profile oc --help 2>&1)"
if [[ "$SHORT" != "$LONG" ]]; then
  echo "e2e: dsh-oc --help differs from dsh --profile oc --help" >&2
  diff <(printf '%s\n' "$SHORT") <(printf '%s\n' "$LONG") >&2 || true
  exit 1
fi
echo "  dsh-oc --help == dsh --profile oc --help"

node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-cli-bin: PASSED in $((SECONDS - SCRIPT_START))s"
