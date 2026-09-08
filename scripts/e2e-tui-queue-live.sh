#!/usr/bin/env bash
# Real opencode TUI live-queue e2e: while a slow mock stream is in flight,
# submit a second prompt from the TUI keyboard and verify the TUI shows it
# as QUEUED (the bridge mirrors dsh pending inbox messages as queued user
# messages even for keyboard submits). Then interrupt and exit cleanly.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
MOCK_PID=""
MOCK_ERR=""
E2E_RUNID=""
# Do not let an early failure kill the branch-wide default tmux name (which
# may belong to another e2e run or a developer). A unique name is assigned
# immediately after e2e_new_run creates the owned run directory.
E2E_TUI_SESSION=""
cleanup() {
  local code=$?
  if [[ -n "$E2E_TUI_SESSION" ]]; then
    tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  fi
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "tui-queue-live" "danger-full-access" "success" "1"
E2E_TUI_SESSION="dsh-oc-tui-queue-live-${E2E_RUNID}"

echo "== start a long slow mock stream =="
MOCK_ERR="$E2E_RUN_DIR/mock-long.err"
node --input-type=module -e '
import { pathToFileURL } from "node:url"
import { join } from "node:path"
const entry = join(process.argv[1],
  "node_modules", "@deepseek-ai", "dsh-llm-mock-server", "lib", "index.js")
const { startMockLlmServer } = await import(pathToFileURL(entry).href)
const server = await startMockLlmServer({
  host: "127.0.0.1",
  port: 0,
  sequence: ["partial_disconnect"],
  repeatLast: true,
  successText: "mock response recovered",
  chunkDelayMs: 100,
  chunkSize: 1,
  partialText: "streaming-live-".repeat(40),
  onEvent(event) {
    if (event.type === "result") {
      process.stderr.write(`mock-llm: ${event.attempt} ${event.behavior} ${event.outcome} ${event.chunksSent}\n`)
    }
  },
})
process.stdout.write("READY " + server.port + "\n")
process.on("SIGTERM", async () => { await server.close(); process.exit(0) })
await new Promise(() => {})
' "$E2E_PROFILE_DIR" \
  > "$E2E_RUN_DIR/mock-long.out" 2> "$MOCK_ERR" &
MOCK_PID=$!

PORT=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if [[ -s "$E2E_RUN_DIR/mock-long.out" ]]; then
    PORT="$(awk '{print $2}' "$E2E_RUN_DIR/mock-long.out" 2>/dev/null || true)"
    if [[ -n "$PORT" ]]; then break; fi
  fi
  sleep 1
done
if [[ -z "$PORT" ]]; then
  echo "e2e: long mock did not start; stderr:" >&2
  tail -20 "$MOCK_ERR" >&2 || true
  exit 1
fi
echo "  long mock on 127.0.0.1:$PORT"

sed -i "s|baseURL: http://127.0.0.1:[0-9]*|baseURL: http://127.0.0.1:${PORT}|" \
  "$E2E_DSH_HOME/settings.yaml"

echo "== boot real opencode TUI =="
e2e_tui_start ""
e2e_tui_wait_attach
REACHED=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
  if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt"; then
    REACHED=1
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$REACHED" ]]; then
  echo "e2e: TUI did not render" >&2
  exit 1
fi
echo "  TUI ready"

echo "== first prompt starts a long stream =="
FIRST_PROMPT="e2e first live prompt"
SECOND_PROMPT="e2e second live queued prompt"
tmux send-keys -t "$E2E_TUI_SESSION" "$FIRST_PROMPT" Enter

# Resolve the session created by this TUI, rather than assuming the first
# listed session. The isolated profile is normally empty, but matching the
# actual first prompt also keeps this correct if a bootstrap session appears.
SID=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  SESSION_LIST="$(e2e_curl -s "$E2E_BRIDGE_URL/session" 2>/dev/null || true)"
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    candidate_history="$(e2e_curl -s "$E2E_BRIDGE_URL/session/$candidate/message" 2>/dev/null || true)"
    if jq -e --arg prompt "$FIRST_PROMPT" '
      any(.[]?; .info.role == "user"
        and any(.parts[]?.text // empty; . == $prompt))
    ' <<<"$candidate_history" >/dev/null 2>&1; then
      SID="$candidate"
      break
    fi
  done < <(jq -r '.[].id // empty' <<<"$SESSION_LIST" 2>/dev/null || true)
  if [[ -n "$SID" ]]; then break; fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while resolving the first prompt session" >&2
    e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-session-failure"
    exit 1
  fi
  sleep 0.2
done
if [[ -z "$SID" ]]; then
  echo "e2e: no session containing the first live prompt was created" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-session-failure"
  tail -80 "$E2E_RUN_DIR/tui-queue-live-session-failure.scrollback.txt" >&2 || true
  exit 1
fi
echo "  TUI session $SID"

echo "== wait for the API to expose the in-flight assistant =="
PENDING_ASSISTANT_ID=""
PENDING_HISTORY=""
STREAM_MARKER_HINT="not yet visible"
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  PENDING_HISTORY="$(e2e_curl -s "$E2E_BRIDGE_URL/session/$SID/message" 2>/dev/null || true)"
  if jq -e '
    [ .[]? | select(.info.role == "assistant") ] | last
    | (.info.id != null and .info.id != "" and .info.time.completed == null)
  ' <<<"$PENDING_HISTORY" >/dev/null 2>&1; then
    PENDING_ASSISTANT_ID="$(jq -r '[.[]? | select(.info.role == "assistant")] | last.info.id // empty' <<<"$PENDING_HISTORY")"
    if grep -qa 'streaming-live' <<<"$PENDING_HISTORY"; then
      STREAM_MARKER_HINT="visible in API history"
    fi
    e2e_tui_capture "$E2E_RUN_DIR/tui-first-pending.txt"
    if grep -qa 'streaming-live' "$E2E_RUN_DIR/tui-first-pending.txt"; then
      if [[ "$STREAM_MARKER_HINT" == "visible in API history" ]]; then
        STREAM_MARKER_HINT="visible in API history and pane"
      else
        STREAM_MARKER_HINT="visible in pane"
      fi
    fi
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for an in-flight assistant" >&2
    e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-pending-failure"
    printf '%s\n' "$PENDING_HISTORY" > "$E2E_RUN_DIR/tui-queue-live-pending-history.json"
    exit 1
  fi
  sleep 0.2
done
if [[ -z "$PENDING_ASSISTANT_ID" ]]; then
  echo "e2e: API never exposed a last assistant without time.completed" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-pending-failure"
  printf '%s\n' "$PENDING_HISTORY" > "$E2E_RUN_DIR/tui-queue-live-pending-history.json"
  tail -80 "$E2E_RUN_DIR/tui-queue-live-pending-failure.scrollback.txt" >&2 || true
  exit 1
fi
echo "  pending assistant $PENDING_ASSISTANT_ID; streaming marker: $STREAM_MARKER_HINT"

echo "== second prompt from the keyboard queues while streaming =="
tmux send-keys -t "$E2E_TUI_SESSION" "$SECOND_PROMPT" Enter

QUEUED_HINT=""
ORDER_HINT=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-queue-live.txt"
  QUEUED_HINT=""
  ORDER_HINT=""
  if grep -qa "$SECOND_PROMPT" "$E2E_RUN_DIR/tui-queue-live.txt" \
    && grep -qa "QUEUED" "$E2E_RUN_DIR/tui-queue-live.txt"; then
    QUEUED_HINT="keyboard prompt visible with QUEUED badge"
  fi
  CURRENT_HISTORY="$(e2e_curl -s "$E2E_BRIDGE_URL/session/$SID/message" 2>/dev/null || true)"
  if jq -e --arg assistant "$PENDING_ASSISTANT_ID" --arg prompt "$SECOND_PROMPT" '
    (to_entries | map(select(.value.info.id == $assistant)) | .[0].key) as $assistantIndex
    | (to_entries | map(select(.value.info.role == "user"
        and any(.value.parts[]?.text // empty; . == $prompt))) | .[0].key) as $userIndex
    | ($assistantIndex != null and $userIndex != null and $userIndex > $assistantIndex)
  ' <<<"$CURRENT_HISTORY" >/dev/null 2>&1; then
    ORDER_HINT="second user follows pending assistant in API history"
  fi
  # A queued inbox item is intentionally not durable history until dsh claims
  # it. During this live window the pane is the authoritative presentation:
  # the assistant card header must precede the queued second user card. Keep
  # the API assertion above when the host has already persisted the user, but
  # do not turn the expected inbox-vs-history boundary into a timing failure.
  if [[ -z "$ORDER_HINT" ]]; then
    assistant_line="$(grep -n -m1 '▣' "$E2E_RUN_DIR/tui-queue-live.txt" | cut -d: -f1 || true)"
    second_line="$(grep -n -m1 -F "$SECOND_PROMPT" "$E2E_RUN_DIR/tui-queue-live.txt" | cut -d: -f1 || true)"
    if [[ "$assistant_line" =~ ^[0-9]+$ && "$second_line" =~ ^[0-9]+$ ]] \
      && (( second_line > assistant_line )); then
      ORDER_HINT="second user follows pending assistant card in pane"
    fi
  fi
  if [[ -n "$QUEUED_HINT" && -n "$ORDER_HINT" ]]; then
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for the queued prompt" >&2
    e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-failure"
    printf '%s\n' "$CURRENT_HISTORY" > "$E2E_RUN_DIR/tui-queue-live-history-failure.json"
    exit 1
  fi
  sleep 0.2
done
if [[ -z "$QUEUED_HINT" || -z "$ORDER_HINT" ]]; then
  echo "e2e: queued keyboard prompt/order oracle failed (queued=${QUEUED_HINT:-no}, order=${ORDER_HINT:-no}); pane:" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-queue-live-failure"
  printf '%s\n' "${CURRENT_HISTORY:-$PENDING_HISTORY}" > "$E2E_RUN_DIR/tui-queue-live-history-failure.json"
  tail -100 "$E2E_RUN_DIR/tui-queue-live-failure.scrollback.txt" >&2 || true
  exit 1
fi
echo "  $QUEUED_HINT; $ORDER_HINT"

echo "== interrupt the stream =="
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 5

echo "== exit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-queue-live: PASSED in $((SECONDS - SCRIPT_START))s"
