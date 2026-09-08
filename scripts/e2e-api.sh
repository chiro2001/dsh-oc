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
# This suite needs both provider-owned `max` and `off` efforts. The generic
# mock-host defaults to thinking disabled for faster API coverage; enabling
# thinking exposes the provider's default high effort without selecting either
# target value in the fixture.
sed -i '/^  thinking: disabled$/c\  thinking: enabled' "$E2E_DSH_HOME/settings.yaml"
# Keep the orphan check scoped to this invocation. A previous manually
# interrupted run may leave a dsh process alive; it is external state and must
# be reported, never killed by this test. Only a new process matching the
# current checkout/run convention is a leak attributable to this invocation.
ORPHAN_BASELINE="$E2E_RUN/orphan-baseline.pids"
ps -eo pid=,args= | awk -v root="$E2E_REPO_ROOT/.e2e/" \
  '$0 ~ root && $0 ~ /agent-model[.]patch[.]yml/ && ($0 ~ /dsh --profile/ || $0 ~ /fake-opencode/) { print $1 }' \
  | sort -n -u > "$ORPHAN_BASELINE"

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
  "/experimental/session" \
  "/api/location" \
  "/api/health" \
  "/api/session/active" \
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
  "/session/dummy/children" \
  "/api/model?location[directory]=$E2E_WORKDIR" \
  "/api/provider?location[directory]=$E2E_WORKDIR" \
  "/api/integration?location[directory]=$E2E_WORKDIR" \
; do
  matrix_get "$path"
done
echo "route matrix: $(grep -c ' yes$' "$ROUTE_MATRIX")/$(wc -l < "$ROUTE_MATRIX") passed"

echo "== vcs assertions =="
git -C "$E2E_WORKDIR" config user.email e2e@dsh-oc.test
git -C "$E2E_WORKDIR" config user.name 'dsh-oc e2e'
printf 'one\n' > "$E2E_WORKDIR/readme.txt"
git -C "$E2E_WORKDIR" add readme.txt
git -C "$E2E_WORKDIR" commit -qm initial
printf 'two\n' >> "$E2E_WORKDIR/readme.txt"
curl -s "$BRIDGE/vcs" | jq -e '.branch == "main"' >/dev/null
echo "  /vcs reports branch main"
curl -s "$BRIDGE/vcs/status" | jq -e \
  'any(. == {"file":"readme.txt","additions":1,"deletions":0,"status":"modified"})' >/dev/null
echo "  /vcs/status lists modified readme.txt"
curl -s "$BRIDGE/vcs/diff" | jq -e 'length >= 1 and (.[0].patch | type) == "string"' >/dev/null
echo "  /vcs/diff returns a per-file patch"
curl -s "$BRIDGE/vcs/diff/raw" | grep -qa 'diff --git'
echo "  /vcs/diff/raw returns the unified diff"

echo "== fs assertions =="
FS_CONTENT="$(curl -s "$BRIDGE/api/fs/read/readme.txt")"
[[ "$FS_CONTENT" == $'one\ntwo' ]]
echo "  /api/fs/read/readme.txt returns raw file content"
FS_HEADERS="$(curl -s -D - -o /dev/null "$BRIDGE/api/fs/read/readme.txt")"
grep -qi '^Content-Type: text/plain' <<<"$FS_HEADERS"
echo "  /api/fs/read/readme.txt content-type is text/plain"
curl -s "$BRIDGE/api/fs/list" | jq -e \
  --arg w "$E2E_WORKDIR" '.location.directory == $w and any(.data[]; .path == "readme.txt" and .type == "file")' >/dev/null
echo "  /api/fs/list includes readme.txt"
curl -s "$BRIDGE/api/fs/find?query=readme&type=file" | jq -e \
  'any(.data[]; .path == "readme.txt" and .type == "file")' >/dev/null
echo "  /api/fs/find locates readme.txt"
CODE="$(curl -s -o "$E2E_RUN/fs-escape.json" -w '%{http_code}' "$BRIDGE/api/fs/read/..%2Fescape.txt")"
[[ "$CODE" == "400" ]]
echo "  /api/fs/read path escape -> 400"
CODE="$(curl -s -o "$E2E_RUN/fs-list-escape.json" -w '%{http_code}' "$BRIDGE/api/fs/list?path=..%2Foutside")"
[[ "$CODE" == "400" ]]
echo "  /api/fs/list path escape -> 400"
printf 'x\n' > "$E2E_WORKDIR/read me.txt"
curl -s "$BRIDGE/api/fs/find?query=read%20me&type=file" | jq -e \
  'any(.data[]; .path == "read me.txt" and .type == "file")' >/dev/null
echo "  /api/fs/find decodes URL-encoded query"

echo "== lifecycle assertions =="
curl -s "$BRIDGE/global/health" | jq -e '.healthy == true and (.version | length) > 0' >/dev/null
echo "  /global/health reports healthy + version"
curl -s -X POST "$BRIDGE/global/dispose" | jq -e '. == true' >/dev/null
echo "  POST /global/dispose acknowledged"
curl -s -X POST "$BRIDGE/instance/dispose" | jq -e '. == true' >/dev/null
echo "  POST /instance/dispose acknowledged"

echo "== key route shapes =="
curl -s "$BRIDGE/path" | jq -e --arg w "$E2E_WORKDIR" '.directory == $w' >/dev/null
echo "  /path.directory == workdir"
curl -s "$BRIDGE/config" | jq -e 'type == "object"' >/dev/null
echo "  /config is object"
curl -s "$BRIDGE/provider" | jq -e '(.all | type) == "array" and (.all | map(.id) | index("deepseek") != null) and (.all[0].models | has("mock-model"))' >/dev/null
echo "  /provider.all array with deepseek provider and mock-model"
curl -s "$BRIDGE/api/location" | jq -e --arg w "$E2E_WORKDIR" '.directory == $w' >/dev/null
echo "  /api/location.directory == workdir"
curl -s "$BRIDGE/api/health" | jq -e '.healthy == true' >/dev/null
echo "  /api/health healthy"
curl -s "$BRIDGE/api/session/active" | jq -e '.data | type == "object"' >/dev/null
echo "  /api/session/active data object"
curl -s "$BRIDGE/api/model" | jq -e '(.data | type) == "array" and ([.data[].id] | index("mock-model") != null)' >/dev/null
echo "  /api/model.data array with mock-model"
curl -s "$BRIDGE/api/provider" | jq -e '(.data | type) == "array" and ([.data[].id] | index("deepseek") != null)' >/dev/null
echo "  /api/provider.data array with deepseek provider"
curl -s "$BRIDGE/api/provider/deepseek" | jq -e '.data.id == "deepseek"' >/dev/null
echo "  /api/provider/deepseek single provider ok"
curl -s "$BRIDGE/api/model" | jq -e '(.data[] | select(.id == "mock-model") | .variants | length) > 0' >/dev/null
echo "  /api/model mock-model advertises reasoning variants"
curl -s "$BRIDGE/command" | jq -e '([.[].name] | index("preset") != null)' >/dev/null
echo "  /command advertises /preset"
curl -s "$BRIDGE/api/command" | jq -e '([.data[].name] | index("preset") != null)' >/dev/null
echo "  /api/command advertises /preset"
curl -s "$BRIDGE/command" | jq -e '([.[].name] | index("help") != null)' >/dev/null
echo "  /command advertises /help"
curl -s "$BRIDGE/experimental/capabilities" | jq -e '.backgroundSubagents == true' >/dev/null
echo "  background subagents capability enabled"
curl -s -X POST "$BRIDGE/experimental/session/s1/background" | jq -e '. == true' >/dev/null
echo "  background endpoint returns true (no-op)"

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

# Create both effort probes before any explicit selection can update the
# persisted default. A first official Default prompt materializes the
# provider's high default; the target max/off prompt below then has a
# deterministic before-value that is neither target effort.
EFFORT_MAX_SESSION="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{}' | jq -er '.data.id')"
EFFORT_OFF_SESSION="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{}' | jq -er '.data.id')"
wait_default_high() {
  local session_id="$1"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if curl -s "$BRIDGE/api/session/$session_id" | jq -e \
      '.data.model.id == "mock-model" and .data.model.providerID == "deepseek" and .data.model.variant == "high"' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: provider Default did not resolve to high before target effort prompt ($session_id)" >&2
  curl -s "$BRIDGE/api/session/$session_id" >&2 || true
  return 1
}
wait_effort_idle() {
  local session_id="$1"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    local wait_code
    wait_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 35 -X POST "$BRIDGE/api/session/$session_id/wait")"
    if [[ "$wait_code" == "204" ]]; then
      return 0
    fi
    if [[ "$wait_code" != "503" ]]; then
      echo "e2e: session wait returned $wait_code ($session_id)" >&2
      return 1
    fi
    sleep 1
  done
  echo "e2e: effort warmup did not become idle ($session_id)" >&2
  curl -s "$BRIDGE/session/status" >&2 || true
  return 1
}
mock_request_matches_effort() {
  local prompt_text="$1"
  local thinking_type="$2"
  local expected_effort="$3"
  [[ -s "$E2E_MOCK_REQUEST_LOG" ]] || return 1
  if [[ "$expected_effort" == "<absent>" ]]; then
    jq -e --arg p "$prompt_text" --arg t "$thinking_type" '
      any(.[];
        any(.body.messages[]?; .role == "user" and .content == $p)
        and .body.thinking.type == $t
        and ((.body | has("reasoning_effort")) | not)
      )' "$E2E_MOCK_REQUEST_LOG" >/dev/null
  else
    jq -e --arg p "$prompt_text" --arg t "$thinking_type" --arg e "$expected_effort" '
      any(.[];
        any(.body.messages[]?; .role == "user" and .content == $p)
        and .body.thinking.type == $t
        and .body.reasoning_effort == $e
      )' "$E2E_MOCK_REQUEST_LOG" >/dev/null
  fi
}
wait_mock_request_effort() {
  local prompt_text="$1"
  local thinking_type="$2"
  local expected_effort="$3"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if mock_request_matches_effort "$prompt_text" "$thinking_type" "$expected_effort"; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: provider request oracle not observed for $prompt_text" >&2
  tail -5 "$E2E_MOCK_REQUEST_LOG" >&2 2>/dev/null || true
  return 1
}
for effort_session in "$EFFORT_MAX_SESSION" "$EFFORT_OFF_SESSION"; do
  curl -s -X POST "$BRIDGE/api/session/$effort_session/prompt" -H 'Content-Type: application/json' \
    -d '{"model":{"providerID":"deepseek","modelID":"mock-model"},"parts":[{"type":"text","text":"default effort warmup"}]}' \
    | jq -e --arg s "$effort_session" '.data.sessionID == $s and .data.delivery == "queue"' >/dev/null
  wait_default_high "$effort_session"
  wait_effort_idle "$effort_session"
  wait_mock_request_effort "default effort warmup" enabled high
done
echo "  Default warmup resolves to provider high before explicit max/off prompts"

MODEL_SWITCH_CODE="$(curl -s -o "$E2E_RUN/model-switch.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$SESSION_V2/model" \
  -H 'Content-Type: application/json' -d '{"model":{"providerID":"deepseek","id":"mock-model","variant":"off"}}')"
[[ "$MODEL_SWITCH_CODE" == "204" ]]
echo "  POST /api/session/$SESSION_V2/model -> 204"
curl -s "$BRIDGE/api/session/$SESSION_V2" | jq -e --arg s "$SESSION_V2" \
  '.data.id == $s and .data.model.id == "mock-model" and .data.model.providerID == "deepseek" and .data.model.variant == "off"' >/dev/null
echo "  session model selection reflected with variant off"

wait_effort_ref() {
  local session_id="$1"
  local variant="$2"
  local prompt_text="$3"
  local thinking_type="$4"
  local expected_effort="$5"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    local session_body history_body
    session_body="$(curl -s "$BRIDGE/api/session/$session_id")"
    history_body="$(curl -s "$BRIDGE/api/session/$session_id/message")"
    if jq -e --arg v "$variant" '.data.model.variant == $v' <<<"$session_body" >/dev/null \
      && jq -e --arg v "$variant" '[.data[] | select(.type == "user") | .model.variant] | any(. == $v)' <<<"$history_body" >/dev/null \
      && grep -qa '"sessionID":"'"$session_id"'.*"variant":"'"$variant"'"' "$SSE_FILE" \
      && mock_request_matches_effort "$prompt_text" "$thinking_type" "$expected_effort"; then
      return 0
    fi
    sleep 1
  done
  echo "e2e: effort $variant was not present in session/history/live refs for $session_id" >&2
  jq . <<<"$session_body" >&2 || true
  jq . <<<"$history_body" >&2 || true
  tail -20 "$SSE_FILE" >&2 || true
  return 1
}

# Use independent sessions so pending model-selection projections cannot cross
# contaminate one another. The prompt body matches OpenCode 1.18.18 exactly:
# variant is top-level and the nested model carries only provider/model.
EFFORT_MAX_PROMPT_TEXT="effort max deterministic probe"
EFFORT_MAX_PROMPT_CODE="$(curl -s -o "$E2E_RUN/effort-max-prompt.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$EFFORT_MAX_SESSION/prompt" -H 'Content-Type: application/json' \
  -d '{"variant":"max","model":{"providerID":"deepseek","modelID":"mock-model"},"parts":[{"type":"text","text":"effort max deterministic probe"}]}' \
  )"
if [[ "$EFFORT_MAX_PROMPT_CODE" != "200" ]] || ! jq -e --arg s "$EFFORT_MAX_SESSION" '.data.sessionID == $s and .data.delivery == "queue"' "$E2E_RUN/effort-max-prompt.json" >/dev/null; then
  echo "e2e: top-level max prompt failed (http=$EFFORT_MAX_PROMPT_CODE)" >&2
  cat "$E2E_RUN/effort-max-prompt.json" >&2
  exit 1
fi
wait_effort_ref "$EFFORT_MAX_SESSION" max "$EFFORT_MAX_PROMPT_TEXT" enabled max
echo "  official top-level max prompt synchronized session/history/live refs and mock request body"

EFFORT_OFF_PROMPT_TEXT="effort off deterministic probe"
EFFORT_OFF_PROMPT_CODE="$(curl -s -o "$E2E_RUN/effort-off-prompt.json" -w '%{http_code}' -X POST "$BRIDGE/api/session/$EFFORT_OFF_SESSION/prompt" -H 'Content-Type: application/json' \
  -d '{"variant":"off","model":{"providerID":"deepseek","modelID":"mock-model"},"parts":[{"type":"text","text":"effort off deterministic probe"}]}' \
  )"
if [[ "$EFFORT_OFF_PROMPT_CODE" != "200" ]] || ! jq -e --arg s "$EFFORT_OFF_SESSION" '.data.sessionID == $s and .data.delivery == "queue"' "$E2E_RUN/effort-off-prompt.json" >/dev/null; then
  echo "e2e: top-level off prompt failed (http=$EFFORT_OFF_PROMPT_CODE)" >&2
  cat "$E2E_RUN/effort-off-prompt.json" >&2
  exit 1
fi
wait_effort_ref "$EFFORT_OFF_SESSION" off "$EFFORT_OFF_PROMPT_TEXT" disabled '<absent>'
echo "  official top-level off prompt synchronized session/history/live refs and mock request body"

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

echo "== v2 message cursor pagination =="
# dsh history pages are cut only at `turn/start` boundaries. All of the fast
# steer prompts above can legitimately land in one turn, which means a
# `limit=2` request would correctly return that whole turn with no cursor.
# Add one idle prompt after the first turn settles so this assertion exercises
# two real pages instead of depending on timing between concurrent prompts.
PAGINATION_PROMPT="e2e: pagination second turn"
curl -s -X POST "$BRIDGE/session/$SESSION_V1/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$PAGINATION_PROMPT\"}]}" \
  | jq -e '.info.role == "assistant"' >/dev/null
PAGINATION_REPLY_COUNT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  PAGINATION_REPLY_COUNT="$(curl -s "$BRIDGE/session/$SESSION_V1/message" \
    | jq '[.[] | select(.info.role == "assistant") | .parts[]?.text // empty | select(. == "mock response recovered")] | length' \
    2>/dev/null || true)"
  if [[ "$PAGINATION_REPLY_COUNT" -ge 3 ]]; then break; fi
  sleep 1
done
if [[ "$PAGINATION_REPLY_COUNT" -lt 3 ]]; then
  echo "e2e: pagination prompt did not settle a new turn (replies=$PAGINATION_REPLY_COUNT)" >&2
  exit 1
fi
echo "  pagination prompt settled as a second turn (replies=$PAGINATION_REPLY_COUNT)"
PAGE1="$(curl -s "$BRIDGE/api/session/$SESSION_V1/message?limit=2")"
# History also hydrates bridge-only `/help`/`/preset` cards, which are not
# counted by dsh's durable maxMessages page and may therefore make `.data`
# longer than two. Assert the two durable records explicitly and exclude
# synthetic cards from the cross-page overlap check below.
jq -e '([.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not)] | length == 2)
  and ([.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not) | .type] == ["user", "assistant"])
  and (.cursor.previous | type) == "string"' <<<"$PAGE1" >/dev/null
PREV_CURSOR="$(jq -r '.cursor.previous' <<<"$PAGE1")"
PAGE2="$(curl -s "$BRIDGE/api/session/$SESSION_V1/message?limit=2&cursor=$(jq -rn --arg c "$PREV_CURSOR" '$c|@uri')")"
jq -e '([.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not)] | length >= 1)' <<<"$PAGE2" >/dev/null
P1_IDS="$(jq -r '.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not) | .id' <<<"$PAGE1" | sort)"
P2_IDS="$(jq -r '.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not) | .id' <<<"$PAGE2" | sort)"
COMMON_IDS="$(comm -12 <(printf '%s\n' "$P1_IDS") <(printf '%s\n' "$P2_IDS"))"
[[ -z "$COMMON_IDS" ]]
echo "  v2 message cursor pages back without overlapping ids"

echo "== per-session SSE =="
PER_SESSION_PID=""
curl -sN --max-time 60 "$BRIDGE/api/session/$SESSION_V2/event" > "$E2E_RUN/per-session-sse.log" 2>/dev/null &
PER_SESSION_PID=$!
sleep 2
curl -s -X POST "$BRIDGE/api/session/$SESSION_V2/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"per session sse probe"}]}' >/dev/null
PER_SESSION_SEEN=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if grep -qa '"sessionID":"'"$SESSION_V2"'"' "$E2E_RUN/per-session-sse.log" \
    && grep -qa '"type":"session.status"' "$E2E_RUN/per-session-sse.log"; then
    PER_SESSION_SEEN="1"
    break
  fi
  sleep 1
done
kill "$PER_SESSION_PID" 2>/dev/null || true
if [[ -z "$PER_SESSION_SEEN" ]]; then
  echo "e2e: per-session SSE did not stream events for $SESSION_V2" >&2
  tail -20 "$E2E_RUN/per-session-sse.log" >&2 || true
  exit 1
fi
echo "  per-session SSE streams events for the requested session"

echo "== fork lineage =="
USER_MESSAGE_ID="$(curl -s "$BRIDGE/session/$SESSION_V1/message" | jq -er '.[] | select(.info.role == "user") | .info.id' | head -1)"
[[ -n "$USER_MESSAGE_ID" ]]
curl -s "$BRIDGE/session/$SESSION_V1/message/$USER_MESSAGE_ID" | jq -e --arg id "$USER_MESSAGE_ID" '.info.id == $id' >/dev/null
echo "  GET single message by id ok"
# `/api/session/:id/message` prepends bridge-only command cards, which do not
# have durable dsh message rows and therefore are not addressable by the
# single-message endpoint. Select the first durable v2 record for this check.
V2_FIRST_MSG_ID="$(curl -s "$BRIDGE/api/session/$SESSION_V2/message" \
  | jq -r '.data[] | select((.id | startswith("msg_cmd:") or startswith("msg_preset:")) | not) | .id' \
  | head -1)"
[[ -n "$V2_FIRST_MSG_ID" ]]
curl -s "$BRIDGE/api/session/$SESSION_V2/message/$V2_FIRST_MSG_ID" | jq -e --arg id "$V2_FIRST_MSG_ID" '.data.id == $id' >/dev/null
echo "  GET v2 single message by id ok"
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

curl -s -X POST "$BRIDGE/session/$SESSION_V1/init" | jq -e '. == true' >/dev/null
echo "  POST /session/$SESSION_V1/init -> true"
WAIT_CODE="$(curl -s --max-time 35 -o /dev/null -w '%{http_code}' -X POST "$BRIDGE/api/session/$SESSION_V2/wait")"
[[ "$WAIT_CODE" == "204" ]]
echo "  POST /api/session/$SESSION_V2/wait -> 204"
curl -s "$BRIDGE/api/session/$SESSION_V2/context" | jq -e '.data | type == "array"' >/dev/null
echo "  GET /api/session/$SESSION_V2/context data array"

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
e2e_new_run "api-approval" "workspace-write" "tool_call_success,tool_call_success,success,success" "0"
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
  -H 'Content-Type: application/json' -d '{"reply":"always"}')"
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

SAVED_CHECK="$(curl -s "$BRIDGE/api/permission/saved")"
jq -e --arg s "$APPR_SESSION" '.data | any(.sessionID == $s and .id == "\($s):bash")' <<<"$SAVED_CHECK" >/dev/null
echo "  saved permission listed for bash"

SECOND_PROMPT="$(curl -s -X POST "$BRIDGE/session/$APPR_SESSION/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: second bash tool call"}]}')"
jq -e '.info.role == "assistant"' <<<"$SECOND_PROMPT" >/dev/null
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  REPLY_TEXT="$(curl -s "$BRIDGE/session/$APPR_SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$(grep -o 'mock response recovered' <<<"$REPLY_TEXT" | wc -l)" -ge 2 ]]; then break; fi
  sleep 1
done
if [[ "$(grep -o 'mock response recovered' <<<"$REPLY_TEXT" | wc -l)" -lt 2 ]]; then
  echo "e2e: second tool-call assistant reply not seen" >&2
  exit 1
fi
sleep 2
PERMISSION_COUNT="$(curl -s "$BRIDGE/permission" | jq 'length')"
[[ "$PERMISSION_COUNT" == "0" ]]
echo "  second tool call auto-approved without a new permission"

kill "$APPROVAL_SSE_PID" 2>/dev/null || true
wait "$APPROVAL_SSE_PID" 2>/dev/null || true

e2e_stop_dsh "$E2E_SESSION"
e2e_stop_run

echo "== orphan check =="
ORPHAN_SCAN="$(ps -eo pid=,args= | awk -v root="$E2E_REPO_ROOT/.e2e/" \
  '$0 ~ root && $0 ~ /agent-model[.]patch[.]yml/ && ($0 ~ /dsh --profile/ || $0 ~ /fake-opencode/) { print }' || true)"
PREEXISTING_ORPHANS="$(awk -v baseline="$ORPHAN_BASELINE" '
  BEGIN { while ((getline pid < baseline) > 0) seen[pid] = 1; close(baseline) }
  { pid=$1; if (seen[pid]) print }
' <<<"$ORPHAN_SCAN")"
ORPHANS="$(awk -v baseline="$ORPHAN_BASELINE" '
  BEGIN { while ((getline pid < baseline) > 0) seen[pid] = 1; close(baseline) }
  { pid=$1; if (!seen[pid]) print }
' <<<"$ORPHAN_SCAN")"
if [[ -n "$PREEXISTING_ORPHANS" ]]; then
  echo "  pre-existing orphan processes left untouched (diagnostic):" >&2
  echo "$PREEXISTING_ORPHANS" >&2
fi
if [[ -n "$ORPHANS" ]]; then
  echo "e2e: new orphan processes:" >&2
  echo "$ORPHANS" >&2
  exit 1
fi
echo "  no orphan dsh/fake processes"

echo "e2e-api: PASSED in $((SECONDS - SCRIPT_START))s"
