#!/usr/bin/env bash
# dsh-oc API permission e2e: v1 once / v2 always + saved grant / v2 reject,
# saved-grant session isolation, question reply + v2 reject, and error
# branches, all against a real dsh + mock LLM.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
SSE_PID=""

cleanup() {
  local code=$?
  kill "$SSE_PID" 2>/dev/null || true
  wait "$SSE_PID" 2>/dev/null || true
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

open_sse() {
  local bridge="$1"
  local file="$2"
  curl -sN --max-time 180 "$bridge/global/event" > "$file" &
  SSE_PID=$!
  sleep 2
}

create_session() {
  curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' \
    -d '{"agent":"standard"}' | jq -er .id
}

prompt_tool() {
  local sid="$1"
  curl -s -X POST "$BRIDGE/session/$sid/message" -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"e2e: trigger a tool call"}]}' \
    | jq -e '.info.role == "assistant"' >/dev/null
}

wait_permission() {
  local file="$1"
  local sid="${2:-}"
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    curl -s "$BRIDGE/permission" > "$file" || true
    if jq -e 'length > 0' "$file" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "e2e: no permission within 60s" >&2
  cat "$file" >&2 2>/dev/null || true
  echo "--- session messages ---" >&2
  if [[ -n "$sid" ]]; then
    curl -s "$BRIDGE/session/$sid/message" | jq -r '.. | objects | select(has("text")) | .text' 2>/dev/null | tail -8 >&2 || true
  fi
  echo "--- mock log tail ---" >&2
  tail -8 "$E2E_MOCK_ERR" >&2 2>/dev/null || true
  return 1
}

wait_idle() {
  local sid="$1"
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local st
    st="$(curl -s "$BRIDGE/session/status" | jq -r --arg s "$sid" '.[$s].type // "idle"')"
    if [[ "$st" == "idle" ]]; then return 0; fi
    sleep 2
  done
  echo "e2e: session $sid did not become idle within 120s" >&2
  return 1
}

wait_question() {
  local file="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    curl -s "$BRIDGE/question" > "$file" || true
    if jq -e 'length > 0' "$file" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "e2e: no question within 60s" >&2
  cat "$file" >&2 2>/dev/null || true
  return 1
}

wait_assistant() {
  local sid="$1"
  local n="$2"
  local deadline=$((SECONDS + 90))
  local text=""
  while (( SECONDS < deadline )); do
    text="$(curl -s "$BRIDGE/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$(grep -o 'mock response recovered' <<<"$text" | wc -l)" -ge "$n" ]]; then return 0; fi
    sleep 1
  done
  echo "e2e: reply count $n not seen on $sid" >&2
  curl -s "$BRIDGE/session/$sid/message" >&2 || true
  return 1
}

echo "== run A: v1 once / v2 always / auto-approve / cross-session isolation =="
CORE_SEQ=""
for _i in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -n "$CORE_SEQ" ]]; then CORE_SEQ+=","; fi
  CORE_SEQ+="tool_call_success,success,success"
done
e2e_new_run "api-permission-core" "workspace-write" \
  "$CORE_SEQ" "0"
E2E_SESSION="dsh-oc-api-permission"
E2E_ACTIVE_SESSION="$E2E_SESSION"
e2e_start_dsh "$E2E_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"
open_sse "$BRIDGE" "$E2E_RUN_DIR/perm-sse.txt"

S1="$(create_session)"
echo "  session $S1"

prompt_tool "$S1"
wait_permission "$E2E_RUN_DIR/perm1.json" "$S1"
PID1="$(jq -r '.[0].id' "$E2E_RUN_DIR/perm1.json")"
jq -e --arg s "$S1" '.[0].sessionID == $s and .[0].permission == "bash"' "$E2E_RUN_DIR/perm1.json" >/dev/null
V2_LIST="$(curl -s "$BRIDGE/api/session/$S1/permission")"
jq -e --arg p "$PID1" '.data | length == 1 and .[0].id == $p and .[0].action == "bash"' <<<"$V2_LIST" >/dev/null
echo "  v1 list + v2 per-session list agree"

REQ_LIST="$(curl -s "$BRIDGE/api/permission/request")"
jq -e --arg p "$PID1" '.location | type == "object"' <<<"$REQ_LIST" >/dev/null
jq -e --arg p "$PID1" '.data | any(.id == $p)' <<<"$REQ_LIST" >/dev/null
SINGLE="$(curl -s "$BRIDGE/api/session/$S1/permission/$PID1")"
jq -e --arg p "$PID1" '.data.id == $p and .data.sessionID == "'"$S1"'"' <<<"$SINGLE" >/dev/null
echo "  v2 request list alias + session single-permission get ok"

curl -s -X POST "$BRIDGE/permission/$PID1/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"once"}' | jq -e '. == true' >/dev/null
wait_assistant "$S1" 1
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
SAVED="$(curl -s "$BRIDGE/api/permission/saved")"
if jq -e --arg s "$S1" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED" >/dev/null; then
  echo "e2e: once unexpectedly saved a bash grant" >&2
  exit 1
fi
echo "  v1 once resolved; no saved grant"

prompt_tool "$S1"
wait_permission "$E2E_RUN_DIR/perm2.json" "$S1"
PID2="$(jq -r '.[0].id' "$E2E_RUN_DIR/perm2.json")"
CODE="$(curl -s -o "$E2E_RUN_DIR/v2-always.json" -w '%{http_code}' \
  -X POST "$BRIDGE/api/session/$S1/permission/$PID2/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"always"}')"
[[ "$CODE" == "204" ]]
wait_assistant "$S1" 2
SAVED="$(curl -s "$BRIDGE/api/permission/saved")"
jq -e --arg s "$S1" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED" >/dev/null
echo "  v2 always replied with 204; bash grant saved"

prompt_tool "$S1"
wait_assistant "$S1" 3
sleep 2
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
echo "  same-session third call auto-approved without a dialog"

wait_idle "$S1"
S2="$(create_session)"
echo "  new session $S2"
prompt_tool "$S2"
wait_permission "$E2E_RUN_DIR/perm3.json" "$S2"
PID3="$(jq -r '.[0].id' "$E2E_RUN_DIR/perm3.json")"
jq -e --arg s "$S2" '.[0].sessionID == $s' "$E2E_RUN_DIR/perm3.json" >/dev/null
CODE="$(curl -s -o "$E2E_RUN_DIR/v2-alias.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$S2/permissions/$PID3" -H 'Content-Type: application/json' \
  -d '{"response":"reject"}')"
[[ "$CODE" == "200" ]]
jq -e '. == true' "$E2E_RUN_DIR/v2-alias.json" >/dev/null
wait_assistant "$S2" 1
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
SAVED="$(curl -s "$BRIDGE/api/permission/saved")"
if jq -e --arg s "$S2" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED" >/dev/null; then
  echo "e2e: reject unexpectedly saved a grant for $S2" >&2
  exit 1
fi
echo "  saved grant did not leak across sessions; v2 alias reject ok"

CODE="$(curl -s -o "$E2E_RUN_DIR/saved-delete.json" -w '%{http_code}' \
  -X DELETE "$BRIDGE/api/permission/saved/$S1:bash")"
[[ "$CODE" == "204" ]]
SAVED="$(curl -s "$BRIDGE/api/permission/saved")"
if jq -e --arg s "$S1" '.data | any(.sessionID == $s and (.id | endswith(":bash")))' <<<"$SAVED" >/dev/null; then
  echo "e2e: DELETE did not remove the saved bash grant" >&2
  exit 1
fi
CODE="$(curl -s -o "$E2E_RUN_DIR/saved-delete-404.json" -w '%{http_code}' \
  -X DELETE "$BRIDGE/api/permission/saved/$S1:bash")"
[[ "$CODE" == "404" ]]
echo "  DELETE /api/permission/saved/:id removed grant; second delete -> 404"

prompt_tool "$S1"
wait_permission "$E2E_RUN_DIR/perm4.json" "$S1"
PID4="$(jq -r '.[0].id' "$E2E_RUN_DIR/perm4.json")"
curl -s -X POST "$BRIDGE/permission/$PID4/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"reject"}' | jq -e '. == true' >/dev/null
wait_assistant "$S1" 4
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
echo "  removed grant no longer auto-approves; permission asked again"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
e2e_stop_dsh "$E2E_SESSION"
e2e_stop_run

echo "== run B: question reply with second option + v2 reject =="
QUESTION_SEQ="tool_call_success,success,success,tool_call_success,success,success"
e2e_new_run "api-permission-question" "workspace-write" \
  "$QUESTION_SEQ" "0" \
  '{"questions":[{"id":"q1","question":"Pick a language?","options":[{"label":"Python"},{"label":"Node.js"}]}]}' \
  "ask_user_question"
E2E_SESSION="dsh-oc-api-permission-question"
E2E_ACTIVE_SESSION="$E2E_SESSION"
e2e_start_dsh "$E2E_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"
open_sse "$BRIDGE" "$E2E_RUN_DIR/question-sse.txt"

S3="$(create_session)"
echo "  session $S3"
prompt_tool "$S3"
wait_question "$E2E_RUN_DIR/question1.json"
QID1="$(jq -r '.[0].id' "$E2E_RUN_DIR/question1.json")"
jq -e --arg s "$S3" '.[0].sessionID == $s and (.[0].questions[0].options | length) == 2' "$E2E_RUN_DIR/question1.json" >/dev/null
V2_Q="$(curl -s "$BRIDGE/api/session/$S3/question")"
jq -e --arg q "$QID1" '.data | length == 1 and .[0].id == $q' <<<"$V2_Q" >/dev/null
Q_REQ="$(curl -s "$BRIDGE/api/question/request")"
jq -e --arg q "$QID1" '.location | type == "object"' <<<"$Q_REQ" >/dev/null
jq -e --arg q "$QID1" '.data | any(.id == $q)' <<<"$Q_REQ" >/dev/null
echo "  v2 question request alias lists the pending batch"
curl -s -X POST "$BRIDGE/question/$QID1/reply" -H 'Content-Type: application/json' \
  -d '{"answers":[["Node.js"]]}' | jq -e '. == true' >/dev/null
wait_assistant "$S3" 1
curl -s "$BRIDGE/question" | jq -e 'length == 0' >/dev/null
echo "  v1 question replied with the second option; /question empty"

prompt_tool "$S3"
wait_question "$E2E_RUN_DIR/question2.json"
QID2="$(jq -r '.[0].id' "$E2E_RUN_DIR/question2.json")"
CODE="$(curl -s -o "$E2E_RUN_DIR/v2-question-reject.json" -w '%{http_code}' \
  -X POST "$BRIDGE/api/session/$S3/question/$QID2/reject")"
[[ "$CODE" == "204" ]]
wait_assistant "$S3" 2
curl -s "$BRIDGE/question" | jq -e 'length == 0' >/dev/null
echo "  v2 question reject ok; turn completed"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
e2e_stop_dsh "$E2E_SESSION"
e2e_stop_run

echo "== run C: error branches =="
e2e_new_run "api-permission-errors" "workspace-write" "tool_call_success,success,success" "0"
E2E_SESSION="dsh-oc-api-permission-errors"
E2E_ACTIVE_SESSION="$E2E_SESSION"
e2e_start_dsh "$E2E_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"
open_sse "$BRIDGE" "$E2E_RUN_DIR/error-sse.txt"

S4="$(create_session)"
echo "  session $S4"
prompt_tool "$S4"
wait_permission "$E2E_RUN_DIR/perm4.json" "$S4"
PID4="$(jq -r '.[0].id' "$E2E_RUN_DIR/perm4.json")"

CODE="$(curl -s -o "$E2E_RUN_DIR/err-empty.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$S4/permissions/$PID4" -H 'Content-Type: application/json' -d '{}')"
[[ "$CODE" == "400" ]]
echo "  alias without response -> 400"

CODE="$(curl -s -o "$E2E_RUN_DIR/err-missing.json" -w '%{http_code}' \
  -X POST "$BRIDGE/session/$S4/permissions/nope" -H 'Content-Type: application/json' \
  -d '{"response":"once"}')"
[[ "$CODE" == "404" ]]
echo "  alias with unknown permission -> 404"

CODE="$(curl -s -o "$E2E_RUN_DIR/err-invalid.json" -w '%{http_code}' \
  -X POST "$BRIDGE/permission/$PID4/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"bogus"}')"
[[ "$CODE" == "400" ]]
echo "  invalid v1 reply -> 400"

CODE="$(curl -s -o "$E2E_RUN_DIR/err-missing-v1.json" -w '%{http_code}' \
  -X POST "$BRIDGE/permission/nope/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"once"}')"
[[ "$CODE" == "404" ]]
echo "  v1 unknown permission -> 404"

curl -s -X POST "$BRIDGE/permission/$PID4/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"reject"}' | jq -e '. == true' >/dev/null
wait_assistant "$S4" 1
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
echo "  pending permission still replyable after bad attempts; cleared by reject"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
e2e_stop_dsh "$E2E_SESSION"
e2e_stop_run

echo "== orphan check =="
ORPHANS="$(ps -eo args= | grep -F "$E2E_REPO_ROOT/.e2e/" | grep -F 'agent-model.patch.yml' | grep -v grep || true)"
if [[ -n "$ORPHANS" ]]; then
  echo "e2e: orphan processes:" >&2
  echo "$ORPHANS" >&2
  exit 1
fi
echo "  no orphan dsh/fake processes"

echo "e2e-api-permission: PASSED in $((SECONDS - SCRIPT_START))s"
