#!/usr/bin/env bash
# Golden trace baseline e2e (experiment 1c / vendor ABI): runs the known
# tool-call + follow-up scenario against the official opencode 1.18.18 TUI,
# records the bridge SSE from a session-filtered observer, normalizes the
# trace to tests/fixtures/golden/, and asserts the final v1/v2 graphs are
# exactly-once. The committed normalized trace is the current-version
# baseline for the future upgrade lane.
#
# DSH_OC_GOLDEN_OVERWRITE=1 refreshes the committed golden file.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh
source tests/e2e/recovery-lib.sh

SCRIPT_START=$SECONDS
E2E_RUNID=""
SSE_PID=""
GOLDEN_DIR="$PWD/tests/fixtures/golden"
GOLDEN_FILE="$GOLDEN_DIR/recovery-tool-followup-1.18.18.sse.jsonl"

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$SSE_PID" ]]; then kill "$SSE_PID" 2>/dev/null || true; fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

export DSH_OC_E2E_CHUNK_DELAY_MS=30
export DSH_OC_E2E_CHUNK_SIZE=10
e2e_new_run "golden-trace" "danger-full-access" \
  "tool_call_success,success,success,success" "1" \
  '{"command":"echo rec-ok","description":"tool","sandbox_permissions":"danger-full-access","justification":"e2e"}'

echo "== boot real opencode TUI and drive the tool+follow-up scenario =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'golden trace tool prompt' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

echo "== observer SSE recording =="
curl -sN --max-time 180 "$E2E_BRIDGE_URL/api/session/$SID/event" \
  > "$E2E_RUN_DIR/trace.raw" 2>/dev/null &
SSE_PID=$!

deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if curl -s "$E2E_BRIDGE_URL/api/session/$SID/message" | jq -e '
      [.data[] | select(.type == "assistant")
        | .content[]? | select(.type == "tool" and .state.status == "completed")] | length > 0
    ' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if (( SECONDS >= deadline )); then
  echo "e2e: tool did not complete in time" >&2
  exit 1
fi

tmux send-keys -t "$E2E_TUI_SESSION" 'golden trace text prompt' Enter
recovery_wait_text "$E2E_BRIDGE_URL/session/$SID/message" "golden trace text prompt"
recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
sleep 1
kill "$SSE_PID" 2>/dev/null || true
SSE_PID=""

echo "== exactly-once graph assertions =="
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/final-v1.json" "$E2E_RUN_DIR/final-v2.json"
if ! jq -e '
    ([ .[] | select(.type == "user") ] | length) == 2
    and ([ .[] | select(.type == "assistant") | .parts[]
          | select(.type == "tool" and .status == "completed" and (.text | length) > 0) ] | length) == 1
  ' "$E2E_RUN_DIR/final-v2.json" >/dev/null; then
  echo "e2e: golden scenario final graph unexpected" >&2
  cat "$E2E_RUN_DIR/final-v2.json" >&2
  exit 1
fi
echo "  final graph exactly-once (2 users, tool completed)"

echo "== normalize and store the golden trace =="
node scripts/normalize-golden-trace.mjs \
  "$E2E_RUN_DIR/trace.raw" "$E2E_RUN_DIR/golden.sse.jsonl"
mkdir -p "$GOLDEN_DIR"
if [[ -f "$GOLDEN_FILE" ]]; then
  if ! diff -q "$GOLDEN_FILE" "$E2E_RUN_DIR/golden.sse.jsonl" >/dev/null; then
    if [[ "${DSH_OC_GOLDEN_OVERWRITE:-0}" == "1" ]]; then
      cp "$E2E_RUN_DIR/golden.sse.jsonl" "$GOLDEN_FILE"
      echo "  golden updated (overwrite)"
    else
      echo "e2e: golden trace differs from committed baseline (structural ABI change?)" >&2
      diff "$GOLDEN_FILE" "$E2E_RUN_DIR/golden.sse.jsonl" | sed -n '1,40p' >&2 || true
      exit 1
    fi
  else
    echo "  golden trace matches committed baseline"
  fi
else
  cp "$E2E_RUN_DIR/golden.sse.jsonl" "$GOLDEN_FILE"
  echo "  golden baseline written: $GOLDEN_FILE"
fi

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-golden-trace: PASSED in $((SECONDS - SCRIPT_START))s"
