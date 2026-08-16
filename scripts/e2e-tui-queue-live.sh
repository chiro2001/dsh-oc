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
cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
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
tmux send-keys -t "$E2E_TUI_SESSION" "e2e first live prompt" Enter
sleep 2

echo "== second prompt from the keyboard queues while streaming =="
tmux send-keys -t "$E2E_TUI_SESSION" "e2e second live queued prompt" Enter

QUEUED_HINT=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-queue-live.txt"
  if grep -qa "e2e second live queued prompt" "$E2E_RUN_DIR/tui-queue-live.txt" \
    && grep -qa "QUEUED" "$E2E_RUN_DIR/tui-queue-live.txt"; then
    QUEUED_HINT="keyboard prompt visible with QUEUED badge"
    break
  fi
  sleep 1
done
if [[ -z "$QUEUED_HINT" ]]; then
  echo "e2e: queued keyboard prompt was not shown with a QUEUED badge; pane:" >&2
  cat "$E2E_RUN_DIR/tui-queue-live.txt" >&2 2>/dev/null || true
  exit 1
fi
echo "  $QUEUED_HINT"

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
