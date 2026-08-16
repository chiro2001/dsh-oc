#!/usr/bin/env bash
# dsh-oc attachment e2e: text data-URL and local file parts are accepted and
# reach the dsh prompt; image parts on a model without image support return a
# readable 400 attachment-error; files outside the session cwd are rejected.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
cleanup() {
  local code=$?
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "api-attachment" "danger-full-access" "success" "1"
E2E_ACTIVE_SESSION="dsh-oc-api-attachment"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"

SID="$(curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
echo "  session $SID"

echo "== text data-URL part =="
CODE="$(curl -s -o "$E2E_RUN_DIR/text-data.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"file","mime":"text/plain","filename":"hello.txt","url":"data:text/plain;base64,aGVsbG8gZnJvbSBkYXRh"}]}')"
[[ "$CODE" == "200" ]]
jq -e '.info.role == "assistant"' "$E2E_RUN_DIR/text-data.json" >/dev/null
echo "  text data-URL accepted (200)"

echo "== local file part inside the session cwd =="
printf 'hello from local file\n' > "$E2E_WORKDIR/notes.txt"
CODE="$(curl -s -o "$E2E_RUN_DIR/text-local.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"file\",\"mime\":\"text/plain\",\"filename\":\"notes.txt\",\"url\":\"file://$E2E_WORKDIR/notes.txt\"}]}")"
[[ "$CODE" == "200" ]]
jq -e '.info.role == "assistant"' "$E2E_RUN_DIR/text-local.json" >/dev/null
echo "  local text file accepted (200)"

echo "== image part on a model without image support =="
PNG="$(printf 'png' | base64)"
CODE="$(curl -s -o "$E2E_RUN_DIR/image.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"file\",\"mime\":\"image/png\",\"filename\":\"pic.png\",\"url\":\"data:image/png;base64,$PNG\"}]}")"
[[ "$CODE" == "400" ]]
jq -e '.data.code == "attachment-error" and .data.details.reason == "MODEL_DOES_NOT_SUPPORT_IMAGES"' "$E2E_RUN_DIR/image.json" >/dev/null
echo "  image rejected with readable attachment-error (400)"

echo "== file outside the session cwd =="
OUTSIDE="$(mktemp -d)"
printf 'outside\n' > "$OUTSIDE/out.txt"
CODE="$(curl -s -o "$E2E_RUN_DIR/outside.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"file\",\"mime\":\"text/plain\",\"filename\":\"out.txt\",\"url\":\"file://$OUTSIDE/out.txt\"}]}")"
[[ "$CODE" == "400" ]]
jq -e '.data.message | test("inside the session cwd")' "$E2E_RUN_DIR/outside.json" >/dev/null
echo "  outside-cwd file rejected (400)"

echo "== orphan check =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-api-attachment: PASSED in $((SECONDS - SCRIPT_START))s"
