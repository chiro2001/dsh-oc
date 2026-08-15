#!/usr/bin/env bash
# dsh-oc API e2e: boot route matrix, v1/v2 session loop, SSE sequence, and
# the approval/permission flow, all against a real dsh + mock LLM.
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

# ---------------------------------------------------------------------------
# Main run: success mock, danger-full-access, fake opencode wrapper.
# ---------------------------------------------------------------------------
e2e_new_run "api-main" "danger-full-access" "success" "1"
E2E_RUN="$E2E_RUN_DIR"
E2E_SESSION="dsh-oc-api"
E2E_ACTIVE_SESSION="$E2E_SESSION"

e2e_start_dsh "$E2E_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"

ROUTE_MATRIX="$E2E_RUN/route-matrix.txt"
: > "$ROUTE_MATRIX"

matrix_get() {
  local path="$1"
  local out="$E2E_RUN/matrix-body.json"
  local headers="$E2E_RUN/matrix-headers.txt"
  local code
  code="$(curl -g -sS -D "$headers" -o "$out" -w '%{http_code}' "$BRIDGE$path")"
  local type="$(tr -d '\r' < "$headers" | awk -F': ' 'tolower($1)=="content-type" {print $2; exit}')"
  local ok=yes
  if ! [[ "$code" =~ ^(200|201|204)$ ]]; then ok=no; fi
  if [[ "$code" != "204" && "$type" != application/json* ]]; then ok=no; fi
  if [[ "$code" != "204" ]] && ! jq -e . "$out" >/dev/null 2>&1; then ok=no; fi
  printf '%-55s %s %-24s %s\n' "$path" "$code" "$type" "$ok" >> "$ROUTE_MATRIX"
  [[ "$ok" == yes ]]
}

echo "== route matrix =="
for path in \
  "/path" \
  "/project/current" \
  "/config/providers" \
  "/provider" \
  "/experimental/capabilities" \
  "/experimental/console" \
  "/agent" \
  "/config" \
  "/project/global/directories" \
  "/session?start=$(( $(date +%s%3N) - 2592000000 ))&path=.&scope=project" \
  "/api/location" \
  "/api/agent" \
  "/api/integration" \
  "/api/model" \
  "/api/provider" \
  "/api/reference" \
  "/api/command" \
  "/api/skill" \
  "/command" \
  "/lsp" \
  "/mcp" \
  "/experimental/resource" \
  "/formatter" \
  "/session/status" \
  "/provider/auth" \
  "/vcs" \
  "/experimental/workspace" \
  "/experimental/workspace/status" \
  "/api/model?location[directory]=$E2E_WORKDIR" \
  "/api/provider?location[directory]=$E2E_WORKDIR" \
  "/api/integration?location[directory]=$E2E_WORKDIR" \
; do
  matrix_get "$path"
done
echo "route matrix: $(grep -c ' yes$' "$ROUTE_MATRIX")/$(wc -l < "$ROUTE_MATRIX") passed"

echo "== key route shapes =="
curl -s "$BRIDGE/path" | jq -e --arg w "$E2E_WORKDIR" '.directory == $w' >/dev/null
echo "  /path.directory == workdir"
curl -s "$BRIDGE/config" | jq -e 'type == "object"' >/dev/null
echo "  /config is object"
curl -s "$BRIDGE/provider" | jq -e '(.all | type) == "array" and (.all | map(.id) | index("deepseek") != null) and (.all[0].models | has("mock-model"))' >/dev/null
echo "  /provider.all array with deepseek provider and mock-model"
curl -s "$BRIDGE/api/location" | jq -e --arg w "$E2E_WORKDIR" '.directory == $w' >/dev/null
echo "  /api/location.directory == workdir"
curl -s "$BRIDGE/api/model" | jq -e '(.data | type) == "array" and ([.data[].id] | index("mock-model") != null)' >/dev/null
echo "  /api/model.data array with mock-model"
curl -s "$BRIDGE/api/provider" | jq -e '(.data | type) == "array" and ([.data[].id] | index("deepseek") != null)' >/dev/null
echo "  /api/provider.data array with deepseek provider"
curl -s "$BRIDGE/api/model" | jq -e '(.data[] | select(.id == "mock-model") | .variants | length) > 0' >/dev/null
echo "  /api/model mock-model advertises reasoning variants"
curl -s "$BRIDGE/command" | jq -e '([.[].name] | index("preset") != null)' >/dev/null
echo "  /command advertises /preset"
curl -s "$BRIDGE/api/command" | jq -e '([.data[].name] | index("preset") != null)' >/dev/null
echo "  /api/command advertises /preset"
curl -s "$BRIDGE/command" | jq -e '([.[].name] | index("help") != null)' >/dev/null
echo "  /command advertises /help"

AGENT_IDS="$(curl -s "$BRIDGE/api/agent" | jq -r '[.data[].id] | join(",")')"
echo "  /api/agent ids: $AGENT_IDS"
if [[ "$AGENT_IDS" == *minimal* ]]; then
  echo "  /api/agent contains minimal"
else
  echo "  /api/agent has no minimal preset in this isolated profile (skipping preset switch)"
fi

echo "== SSE event sequence =="
SSE_FILE="$E2E_RUN/sse-events.txt"
curl -sN --max-time 120 "$BRIDGE/global/event" > "$SSE_FILE" &
SSE_PID=$!
sleep 2

echo "== v1/v2 session loop =="
SESSION_V1="$(curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
echo "  v1 session: $SESSION_V1"
SESSION_V2="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{}' | jq -er .data.id)"
echo "  v2 session: $SESSION_V2"

MODEL_SWITCH_CODE="$(curl -s -o "$E2E_RUN/model-switch.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$SESSION_V2/model" \
  -H 'Content-Type: application/json' -d '{"model":{"providerID":"deepseek","id":"mock-model","variant":"off"}}')"
[[ "$MODEL_SWITCH_CODE" == "204" ]]
echo "  POST /api/session/$SESSION_V2/model -> 204"
curl -s "$BRIDGE/api/session/$SESSION_V2" | jq -e --arg s "$SESSION_V2" \
  '.data.id == $s and .data.model.id == "mock-model" and .data.model.providerID == "deepseek" and .data.model.variant == "off"' >/dev/null
echo "  session model selection reflected with variant off"

PRESET_LIST_CODE="$(curl -s -o "$E2E_RUN/preset-list.json" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V2/command" \
  -H 'Content-Type: application/json' -d '{"command":"preset","arguments":""}')"
[[ "$PRESET_LIST_CODE" == "200" ]]
jq -e '.parts[0].text | type == "string"' "$E2E_RUN/preset-list.json" >/dev/null
echo "  POST /session/$SESSION_V2/command /preset list -> 200"

PRESET_PROMPT_BODY="$E2E_RUN/preset-prompt.json"
PRESET_PROMPT_CODE="$(curl -s -o "$PRESET_PROMPT_BODY" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V2/message" \
  -H 'Content-Type: application/json' -d '{"parts":[{"type":"text","text":"/preset"}]}')"
[[ "$PRESET_PROMPT_CODE" == "200" ]]
jq -e '.parts[0].text | type == "string"' "$PRESET_PROMPT_BODY" >/dev/null
if ! jq -e '.parts[0].text | test("standard|minimal|No switchable dsh agent presets")' "$PRESET_PROMPT_BODY" >/dev/null; then
  echo "e2e: prompt-route /preset did not return a visible preset result" >&2
  cat "$PRESET_PROMPT_BODY" >&2
  exit 1
fi
echo "  POST /session/$SESSION_V2/message /preset captured -> visible preset result"

HELP_PROMPT_BODY="$E2E_RUN/help-prompt.json"
HELP_PROMPT_CODE="$(curl -s -o "$HELP_PROMPT_BODY" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V2/message" \
  -H 'Content-Type: application/json' -d '{"parts":[{"type":"text","text":"/help"}]}')"
[[ "$HELP_PROMPT_CODE" == "200" ]]
jq -e '.parts[0].text | test("核心能力")' "$HELP_PROMPT_BODY" >/dev/null
echo "  POST /session/$SESSION_V2/message /help captured -> visible capability summary"

if [[ "$AGENT_IDS" == *minimal* ]]; then
  AGENT_SWITCH_CODE="$(curl -s -o "$E2E_RUN/agent-switch.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$SESSION_V2/agent" \
    -H 'Content-Type: application/json' -d '{"agent":"minimal"}')"
  [[ "$AGENT_SWITCH_CODE" == "204" ]]
  echo "  POST /api/session/$SESSION_V2/agent minimal -> 204"
  curl -s "$BRIDGE/api/session/$SESSION_V2" | jq -e '.data.agent == "minimal"' >/dev/null
  echo "  session agent preset reflected as minimal"
  PRESET_COMMAND_CODE="$(curl -s -o "$E2E_RUN/preset-command.json" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V2/command" \
    -H 'Content-Type: application/json' -d '{"command":"preset","arguments":"minimal"}')"
  [[ "$PRESET_COMMAND_CODE" == "200" ]]
  echo "  POST /session/$SESSION_V2/command /preset minimal -> 200"
else
  echo "  skipping agent switch assertions (no minimal preset)"
fi

PATCH_BODY="$(curl -s -X PATCH "$BRIDGE/session/$SESSION_V1" -H 'Content-Type: application/json' -d '{"title":"e2e renamed"}' | jq -er '.id == "'"$SESSION_V1"'" and .title == "e2e renamed"')"
[[ "$PATCH_BODY" == true ]]
echo "  PATCH /session/$SESSION_V1 rename ok"

HELP_CMD_OUT="$(curl -s -X POST "$BRIDGE/session/$SESSION_V1/command" -H 'Content-Type: application/json' \
  -d '{"command":"help","arguments":""}')"
jq -e '.parts[0].text | test("dsh-oc") and test("docs/FEATURES.md")' <<<"$HELP_CMD_OUT" >/dev/null
echo "  POST /session/$SESSION_V1/command /help -> visible capability summary"

curl -s -X POST "$BRIDGE/session/$SESSION_V1/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: hello from dsh-oc"}]}' | jq -e '.info.role == "assistant"' >/dev/null
echo "  POST /session/$SESSION_V1/message accepted"

curl -s -X POST "$BRIDGE/session/$SESSION_V1/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: hello from dsh-oc (alias route)"}]}' | jq -e '.info.role == "assistant"' >/dev/null
echo "  POST /session/$SESSION_V1/prompt alias accepted"

FILE_PART_OUT="$(curl -s -X POST "$BRIDGE/session/$SESSION_V1/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"file","mime":"text/plain","filename":"hello.txt","url":"data:text/plain;base64,aGVsbG8gZnJvbSBmaWxl"}]}')"
jq -e '.info.role == "assistant"' <<<"$FILE_PART_OUT" >/dev/null
echo "  POST /session/$SESSION_V1/prompt text file part accepted"

OUTSIDE_FILE_CODE="$(curl -s -o "$E2E_RUN/outside-file.json" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V1/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"file","mime":"text/plain","url":"file:///etc/passwd"}]}')"
[[ "$OUTSIDE_FILE_CODE" == "400" ]]
echo "  file part outside cwd rejected -> 400"

curl -s -X POST "$BRIDGE/api/session/$SESSION_V2/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: hello from dsh-oc (v2 route)"}]}' | jq -e --arg s "$SESSION_V2" '.data.sessionID == $s and .data.delivery == "queue"' >/dev/null
echo "  POST /api/session/$SESSION_V2/prompt accepted"

wait_assistant() {
  local url="$1"
  local want="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$url" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$text" == *"$want"* ]]; then
      echo "  assistant text seen: ${text:0:80}..."
      return 0
    fi
    sleep 1
  done
  echo "e2e: assistant reply not seen for $url" >&2
  curl -s "$url" >&2 || true
  return 1
}

wait_assistant "$BRIDGE/session/$SESSION_V1/message" "mock response recovered"
wait_assistant "$BRIDGE/api/session/$SESSION_V2/message" "mock response recovered"

echo "== fork lineage =="
USER_MESSAGE_ID="$(curl -s "$BRIDGE/session/$SESSION_V1/message" | jq -er '.[] | select(.info.role == "user") | .info.id' | head -1)"
[[ -n "$USER_MESSAGE_ID" ]]
FORKED_AT_MSG_JSON="$(curl -s -X POST "$BRIDGE/session/$SESSION_V1/fork" -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"$USER_MESSAGE_ID\"}")"
FORKED_AT_MSG="$(jq -er .id <<<"$FORKED_AT_MSG_JSON")"
[[ -n "$FORKED_AT_MSG" && "$FORKED_AT_MSG" != "$SESSION_V1" ]]
jq -e --arg f "$FORKED_AT_MSG" --arg t 'e2e renamed (fork #1)' \
  '.id == $f and (has("parentID") | not) and .title == $t' <<<"$FORKED_AT_MSG_JSON" >/dev/null
curl -s "$BRIDGE/session/$FORKED_AT_MSG" | jq -e --arg f "$FORKED_AT_MSG" --arg t 'e2e renamed (fork #1)' \
  '.id == $f and (has("parentID") | not) and .title == $t' >/dev/null
echo "  fork at message $USER_MESSAGE_ID -> $FORKED_AT_MSG (fork #1)"
FORKED_V1_JSON="$(curl -s -X POST "$BRIDGE/session/$SESSION_V1/fork" -H 'Content-Type: application/json' -d '{}')"
FORKED_V1="$(jq -er .id <<<"$FORKED_V1_JSON")"
[[ -n "$FORKED_V1" && "$FORKED_V1" != "$SESSION_V1" ]]
jq -e --arg f "$FORKED_V1" --arg t 'e2e renamed (fork #2)' \
  '.id == $f and (has("parentID") | not) and .title == $t' <<<"$FORKED_V1_JSON" >/dev/null
curl -s "$BRIDGE/session/$FORKED_V1" | jq -e --arg f "$FORKED_V1" --arg t 'e2e renamed (fork #2)' \
  '.id == $f and (has("parentID") | not) and .title == $t' >/dev/null
echo "  v1 fork: $FORKED_V1 (fork #2)"
FORKED_V2_JSON="$(curl -s -X POST "$BRIDGE/api/session/$SESSION_V1/fork" -H 'Content-Type: application/json' -d '{}')"
FORKED_V2="$(jq -er .data.id <<<"$FORKED_V2_JSON")"
[[ -n "$FORKED_V2" && "$FORKED_V2" != "$SESSION_V1" ]]
jq -e --arg f "$FORKED_V2" --arg t 'e2e renamed (fork #3)' \
  '.data.id == $f and (.data | has("parentID") | not) and .data.title == $t' <<<"$FORKED_V2_JSON" >/dev/null
curl -s "$BRIDGE/api/session/$FORKED_V2" | jq -e --arg f "$FORKED_V2" --arg t 'e2e renamed (fork #3)' \
  '.data.id == $f and (.data | has("parentID") | not) and .data.title == $t' >/dev/null
echo "  v2 fork: $FORKED_V2 (fork #3)"

# Forking a fork advances its chain instead of stacking another suffix.
FORK_CHAIN_JSON="$(curl -s -X POST "$BRIDGE/session/$FORKED_AT_MSG/fork" -H 'Content-Type: application/json' -d '{}')"
FORK_CHAIN="$(jq -er .id <<<"$FORK_CHAIN_JSON")"
[[ -n "$FORK_CHAIN" && "$FORK_CHAIN" != "$FORKED_AT_MSG" ]]
jq -e --arg f "$FORK_CHAIN" --arg t 'e2e renamed (fork #2)'   '.id == $f and (has("parentID") | not) and .title == $t' <<<"$FORK_CHAIN_JSON" >/dev/null
curl -s "$BRIDGE/session/$FORK_CHAIN" | jq -e --arg f "$FORK_CHAIN" --arg t 'e2e renamed (fork #2)'   '.id == $f and (has("parentID") | not) and .title == $t' >/dev/null
echo "  fork chain: $FORKED_AT_MSG -> $FORK_CHAIN (fork #2)"

echo "== compact =="
COMPACT_CODE="$(curl -s -o "$E2E_RUN/compact-summarize.json" -w '%{http_code}' -X POST "$BRIDGE/session/$SESSION_V1/summarize" \
  -H 'Content-Type: application/json' -d '{"providerID":"deepseek","modelID":"mock-model"}')"
if jq -e '. == true' "$E2E_RUN/compact-summarize.json" >/dev/null; then
  COMPACT_OK=yes
elif [[ "$COMPACT_CODE" =~ ^(400|409)$ ]] && jq -e '.name == "BadRequest" and .data.code == "command-error"' "$E2E_RUN/compact-summarize.json" >/dev/null; then
  # The mock LLM cannot produce a useful compaction summary; the route and dsh
  # command still executed correctly. Real-model compaction is covered manually.
  COMPACT_OK=mock-summary-unavailable
else
  [[ "$COMPACT_CODE" =~ ^(200|204)$ ]]
  COMPACT_OK=""
fi
echo "  POST /session/$SESSION_V1/summarize -> $COMPACT_CODE ($COMPACT_OK)"
if [[ "$COMPACT_OK" == yes ]]; then
  COMPACT_SEEN=""
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -s "$BRIDGE/session/$SESSION_V1/message" | jq -e 'any(.[]; (.parts // []) | any(.type == "compaction"))' >/dev/null 2>&1; then
      COMPACT_SEEN=yes
      echo "  compaction checkpoint visible in history"
      break
    fi
    sleep 1
  done
  [[ "$COMPACT_SEEN" == yes ]]
fi
COMPACT_V2_CODE="$(curl -s -o "$E2E_RUN/compact-v2.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$SESSION_V2/compact")"
if [[ "$COMPACT_V2_CODE" =~ ^(200|204)$ ]] || { [[ "$COMPACT_V2_CODE" =~ ^(400|409)$ ]] && jq -e '.name == "BadRequest" and .data.code == "command-error"' "$E2E_RUN/compact-v2.json" >/dev/null 2>&1; }; then
  echo "  POST /api/session/$SESSION_V2/compact -> $COMPACT_V2_CODE"
else
  echo "  compact v2 body: $(cat "$E2E_RUN/compact-v2.json" 2>/dev/null || true)" >&2
  exit 1
fi

TODO_LEN="$(curl -s "$BRIDGE/session/$SESSION_V1/todo" | jq -e 'type == "array"' >/dev/null && echo array)"
echo "  todo: $TODO_LEN"
DIFF_LEN="$(curl -s "$BRIDGE/session/$SESSION_V1/diff" | jq -e 'type == "array"' >/dev/null && echo array)"
echo "  diff: $DIFF_LEN"

curl -s -X POST "$BRIDGE/session/$SESSION_V1/abort" | jq -e '. == true' >/dev/null
echo "  POST /session/$SESSION_V1/abort ok"
curl -s -X POST "$BRIDGE/api/session/$SESSION_V2/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"abort probe"}]}' >/dev/null
sleep 1
curl -s -X POST "$BRIDGE/session/$SESSION_V2/abort" | jq -e '. == true' >/dev/null
echo "  POST /session/$SESSION_V2/abort ok"

echo "== permission/question baseline =="
curl -s "$BRIDGE/permission" | jq -e 'type == "array" and length == 0' >/dev/null
curl -s "$BRIDGE/question" | jq -e 'type == "array" and length == 0' >/dev/null
echo "  /permission and /question empty"

sleep 2
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true

echo "== SSE assertions =="
SSE_DATA="$E2E_RUN/sse-data.txt"
grep '^data: ' "$SSE_FILE" | sed 's/^data: //' > "$SSE_DATA"
grep -q '"type":"session.updated"' "$SSE_DATA" || grep -q '"type":"session.created"' "$SSE_DATA"
echo "  session.created/session.updated seen"
grep -q '"type":"session.status"' "$SSE_DATA"
echo "  session.status seen"
grep -q '"type":"message.updated"' "$SSE_DATA" || grep -q '"type":"message.part.updated"' "$SSE_DATA"
echo "  message.updated/message.part.updated seen"
grep -q '"type":"session.idle"' "$SSE_DATA" || grep -q '"type":"session.status".*"type":"idle"' "$SSE_DATA"
echo "  session idle terminal seen"
awk '/^\{/ && !/"directory"/ { print "missing directory: " $0; bad=1 } END { exit bad }' "$SSE_DATA"
echo "  every SSE frame carries directory"
grep -q '"type":"session.status".*"type":"busy"' "$SSE_DATA"
echo "  busy status seen"

e2e_stop_dsh "$E2E_SESSION"
e2e_stop_run

echo "== approval/permission run =="
# dsh's DSH_PERMISSION_MODE accepts sandbox modes only; workspace-write maps
# to sandbox=workspace-write + approval=ask, which is what this test needs.
e2e_new_run "api-approval" "workspace-write" "tool_call_success,success,success,success" "0"
E2E_SESSION="dsh-oc-api-approval"
E2E_ACTIVE_SESSION="$E2E_SESSION"
e2e_start_dsh "$E2E_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"

curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
curl -s "$BRIDGE/question" | jq -e 'length == 0' >/dev/null
echo "  baseline permission/question empty"

# The bridge learns about pending approvals from the mux stream, so the test
# keeps one SSE listener open (exactly like a connected TUI would).
APPROVAL_SSE="$E2E_RUN/approval-sse.txt"
curl -sN --max-time 120 "$BRIDGE/global/event" > "$APPROVAL_SSE" &
APPROVAL_SSE_PID=$!
sleep 2

APPR_SESSION="$(curl -s -X POST "$BRIDGE/session" -H 'Content-Type: application/json' -d '{"agent":"standard"}' | jq -er .id)"
echo "  approval session: $APPR_SESSION"
PROMPT_OUT="$(curl -s -X POST "$BRIDGE/session/$APPR_SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: trigger a bash tool call"}]}')"
jq -e '.info.role == "assistant"' <<<"$PROMPT_OUT" >/dev/null
echo "  approval prompt accepted"

PERMISSION_ID=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  PERMISSION_JSON="$(curl -s "$BRIDGE/permission")"
  if [[ "$(jq 'length' <<<"$PERMISSION_JSON")" -gt 0 ]]; then
    PERMISSION_ID="$(jq -r '.[0].id' <<<"$PERMISSION_JSON")"
    echo "  permission asked: $PERMISSION_ID (tool=$(jq -r '.[0].metadata.toolName' <<<"$PERMISSION_JSON"))"
    break
  fi
  sleep 1
done
if [[ -z "$PERMISSION_ID" ]]; then
  echo "e2e: no permission requested within 60s; latest /permission:" >&2
  echo "$PERMISSION_JSON" >&2
fi
[[ -n "$PERMISSION_ID" ]]
echo "$PERMISSION_JSON" | jq -e '.[0].sessionID == "'"$APPR_SESSION"'"' >/dev/null

REPLY_CODE="$(curl -s -o "$E2E_RUN/permission-reply.json" -w '%{http_code}' -X POST "$BRIDGE/permission/$PERMISSION_ID/reply" \
  -H 'Content-Type: application/json' -d '{"reply":"once"}')"
[[ "$REPLY_CODE" =~ ^(200|204)$ ]]
echo "  POST /permission/$PERMISSION_ID/reply -> $REPLY_CODE"

wait_assistant "$BRIDGE/session/$APPR_SESSION/message" "mock response recovered"
curl -s "$BRIDGE/permission" | jq -e 'length == 0' >/dev/null
echo "  permission cleared after reply"

echo "== streamed tool event assertions =="
APPROVAL_SSE_DATA="$E2E_RUN/approval-sse-data.txt"
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  grep '^data: ' "$APPROVAL_SSE" | sed 's/^data: //' > "$APPROVAL_SSE_DATA"
  if grep -q '"type":"session.next.tool.success"' "$APPROVAL_SSE_DATA"; then break; fi
  sleep 1
done
for pattern in \
  '"type":"session.next.tool.input.started"' \
  '"type":"session.next.tool.input.delta"' \
  '"type":"session.next.tool.called"' \
  '"type":"session.next.tool.progress"' \
  '"type":"session.next.tool.success"'; do
  if ! grep -q "$pattern" "$APPROVAL_SSE_DATA"; then
    echo "e2e: missing streamed tool event $pattern" >&2
    exit 1
  fi
done
echo "  session.next.tool.input.started/delta/called/progress/success seen"

kill "$APPROVAL_SSE_PID" 2>/dev/null || true
wait "$APPROVAL_SSE_PID" 2>/dev/null || true

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

echo "e2e-api: PASSED in $((SECONDS - SCRIPT_START))s"
