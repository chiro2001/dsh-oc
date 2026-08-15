#!/usr/bin/env bash
# Real TUI interrupt e2e: prompt a slow streaming mock, press Esc twice
# (full TUI's interrupt key), and assert the bridge cancel stops the stream
# long before the mock would finish.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
MOCK_PID=""
MOCK_ERR=""
V2_SSE_PID=""

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  if [[ -n "$V2_SSE_PID" ]]; then
    kill "$V2_SSE_PID" 2>/dev/null || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "tui-abort" "danger-full-access" "success" "1"

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
  partialText: "interrupt-me-".repeat(40),
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

# Point the run's LLM settings at the long mock.
sed -i "s|baseURL: http://127.0.0.1:[0-9]*|baseURL: http://127.0.0.1:${PORT}|" \
  "$E2E_DSH_HOME/settings.yaml"

echo "== boot real opencode TUI and prompt =="
e2e_tui_start ""
e2e_tui_wait_attach

REACHED=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
  if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt"; then
    REACHED="1"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$REACHED" ]]; then
  echo "e2e: TUI did not render before prompt" >&2
  tail -40 "$E2E_RUN_DIR/tui-ready.txt" >&2 || true
  exit 1
fi
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'interrupt e2e test' Enter
sleep 1
SESSION_ID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SESSION_ID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SESSION_ID" ]]; then break; fi
  sleep 1
done
if [[ -z "$SESSION_ID" ]]; then
  echo "e2e: prompt did not create a session" >&2
  exit 1
fi
echo "  session $SESSION_ID"
sleep 3

echo "== press Esc twice to interrupt =="
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 5

if [[ ! -s "$MOCK_ERR" ]] || ! rg -q 'client_closed' "$MOCK_ERR"; then
  echo "e2e: mock did not observe a client close after Esc (interrupt not delivered)" >&2
  tail -5 "$MOCK_ERR" >&2 || true
  tmux capture-pane -p -t "$E2E_TUI_SESSION" > "$E2E_RUN_DIR/tui-after-esc.txt" 2>/dev/null || true
  exit 1
fi
CHUNKS="$(tail -1 "$MOCK_ERR" | sed -E 's/.* ([0-9]+)$/\1/' )"
if [[ "${CHUNKS:-999}" -ge 200 ]]; then
  echo "e2e: stream ran too long before closing (chunks=$CHUNKS); cancel was not effective" >&2
  exit 1
fi
echo "  mock observed client close after $CHUNKS chunks (cancel effective)"

e2e_tui_capture "$E2E_RUN_DIR/tui-abort.txt"
if rg -qa 'interrupting|Interrupt' "$E2E_RUN_DIR/tui-abort.txt"; then
  echo "  TUI shows interrupt notice"
fi

echo "== v2 interrupt alias =="
BEFORE_V2="$(wc -l < "$MOCK_ERR")"
curl -sN --max-time 60 "$E2E_BRIDGE_URL/global/event" > "$E2E_RUN_DIR/v2-sse.log" 2>/dev/null &
V2_SSE_PID=$!
curl -s -X POST "$E2E_BRIDGE_URL/session/$SESSION_ID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"interrupt via v2 api"}]}' >/dev/null
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  if grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/v2-sse.log"; then
    break
  fi
  sleep 1
done
if ! grep -qa '"type":"message.part.delta"' "$E2E_RUN_DIR/v2-sse.log"; then
  echo "e2e: v2 stream did not start before interrupt" >&2
  tail -20 "$E2E_RUN_DIR/v2-sse.log" >&2 || true
  exit 1
fi
kill "$V2_SSE_PID" 2>/dev/null || true
V2_SSE_PID=""
V2_CODE=""
V2_CLOSED=""
for _ in 1 2 3; do
  V2_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_BRIDGE_URL/api/session/$SESSION_ID/interrupt")"
  if [[ "$V2_CODE" != "204" ]]; then
    break
  fi
  deadline=$((SECONDS + 8))
  while (( SECONDS < deadline )); do
    if (( $(wc -l < "$MOCK_ERR") > BEFORE_V2 )) && tail -1 "$MOCK_ERR" | rg -q 'client_closed'; then
      V2_CLOSED="1"
      break
    fi
    sleep 1
  done
  if [[ -n "$V2_CLOSED" ]]; then
    break
  fi
  sleep 1
done
if [[ "$V2_CODE" != "204" ]]; then
  echo "e2e: v2 interrupt returned $V2_CODE (expected 204)" >&2
  exit 1
fi
if [[ -z "$V2_CLOSED" ]]; then
  echo "e2e: v2 interrupt did not close the mock stream" >&2
  tail -5 "$MOCK_ERR" >&2 || true
  exit 1
fi
V2_CHUNKS="$(tail -1 "$MOCK_ERR" | sed -E 's/.* ([0-9]+)$/\1/')"
if [[ "${V2_CHUNKS:-999}" -ge 200 ]]; then
  echo "e2e: v2 interrupt closed too late (chunks=$V2_CHUNKS)" >&2
  exit 1
fi
echo "  v2 interrupt returned 204 and closed the mock stream"

echo "== mini single-Esc interrupt =="
tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null
BEFORE_LINES="$(wc -l < "$MOCK_ERR")"
e2e_tui_start "--mini"
e2e_tui_wait_attach
REACHED=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-mini-ready.txt"
  if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-mini-ready.txt"; then
    REACHED="1"
    break
  fi
  sleep 1
done
if [[ -z "$REACHED" ]]; then
  echo "e2e: mini TUI did not render" >&2
  exit 1
fi
SSE_PID=""
curl -sN "$E2E_BRIDGE_URL/global/event" > "$E2E_RUN_DIR/mini-sse.log" 2>/dev/null &
SSE_PID=$!
tmux send-keys -t "$E2E_TUI_SESSION" 'mini interrupt e2e' Enter
deadline=$((SECONDS + 25))
while (( SECONDS < deadline )); do
  if rg -q 'message.part.delta' "$E2E_RUN_DIR/mini-sse.log" 2>/dev/null; then
    break
  fi
  sleep 1
done
if ! rg -q 'message.part.delta' "$E2E_RUN_DIR/mini-sse.log" 2>/dev/null; then
  echo "e2e: mini stream did not start before Esc" >&2
  kill "$SSE_PID" 2>/dev/null || true
  exit 1
fi
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" Escape
sleep 5
kill "$SSE_PID" 2>/dev/null || true
MINI_LINES="$(wc -l < "$MOCK_ERR")"
if (( MINI_LINES <= BEFORE_LINES )); then
  echo "e2e: mini Esc did not close the mock stream" >&2
  tail -3 "$MOCK_ERR" >&2 || true
  exit 1
fi
MINI_CHUNKS="$(tail -1 "$MOCK_ERR" | sed -E 's/.* ([0-9]+)$/\1/')"
if [[ -z "${MINI_CHUNKS:-}" || "${MINI_CHUNKS:-0}" -eq 0 || "${MINI_CHUNKS:-999}" -ge 200 ]]; then
  echo "e2e: mini interrupt chunk count out of range (chunks=$MINI_CHUNKS)" >&2
  exit 1
fi
echo "  mini Esc closed the stream after $MINI_CHUNKS chunks"

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null
kill "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-abort: PASSED in $((SECONDS - SCRIPT_START))s"
