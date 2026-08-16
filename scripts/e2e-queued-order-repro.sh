#!/usr/bin/env bash
# Official-TUI out-of-order repro record (experiment 1c): drives the known
# edge case against the real opencode 1.18.18 TUI:
#   tool-call turn -> tool result -> slow follow-up text streaming
#   -> second prompt queued from the keyboard while the follow-up streams
# The script records the observed pane ordering (follow-up vs queued card),
# freezes a normalized bridge SSE trace as a golden baseline, and asserts
# the final API graph is exactly-once. It PASSES regardless of the observed
# order: this is reproducible evidence for the renderer-attribution question,
# not a gate.
#
# DSH_OC_GOLDEN_OVERWRITE=1 refreshes the queued-followup golden file.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh
source tests/e2e/recovery-lib.sh

SCRIPT_START=$SECONDS
E2E_RUNID=""
SSE_PID=""
GOLDEN_DIR="$PWD/tests/fixtures/golden"
GOLDEN_FILE="$GOLDEN_DIR/queued-followup-1.18.18.sse.jsonl"
FOLLOWUP_TEXT="order-repro-followup "

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

export DSH_OC_E2E_CHUNK_DELAY_MS=150
export DSH_OC_E2E_CHUNK_SIZE=4
export DSH_OC_E2E_SUCCESS_TEXT="order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup order-repro-followup"
e2e_new_run "queued-order-repro" "danger-full-access" \
  "tool_call_success,slow_success,slow_success,slow_success,slow_success,slow_success" "1" \
  '{"command":"echo order-repro","description":"tool","sandbox_permissions":"danger-full-access","justification":"e2e"}'

echo "== boot real opencode TUI and start the tool turn =="
e2e_tui_start ""
e2e_tui_wait_attach
recovery_wait_tui_ready
echo "  TUI ready"

tmux send-keys -t "$E2E_TUI_SESSION" 'order repro tool prompt' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

curl -sN --max-time 180 "$E2E_BRIDGE_URL/api/session/$SID/event" \
  > "$E2E_RUN_DIR/trace.raw" 2>/dev/null &
SSE_PID=$!

echo "== wait for the tool part, then queue a second prompt while busy =="
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if curl -s "$E2E_BRIDGE_URL/api/session/$SID/message" | jq -e '
      [.data[] | select(.type == "assistant")
        | .content[]? | select(.type == "tool")] | length > 0
    ' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if (( SECONDS >= deadline )); then
  echo "e2e: tool part did not appear in time" >&2
  exit 1
fi
echo "  tool part visible; sending queued prompt"
tmux send-keys -t "$E2E_TUI_SESSION" 'order repro queued prompt' Enter

QUEUED_SEEN=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-queued.txt"
  if grep -qa 'order repro queued prompt' "$E2E_RUN_DIR/tui-queued.txt" \
    && grep -qa 'QUEUED' "$E2E_RUN_DIR/tui-queued.txt"; then
    QUEUED_SEEN="1"
    break
  fi
  sleep 1
done
if [[ -z "$QUEUED_SEEN" ]]; then
  echo "e2e: queued prompt not shown with QUEUED badge" >&2
  tail -30 "$E2E_RUN_DIR/tui-queued.txt" >&2 || true
  exit 1
fi
echo "  QUEUED badge observed"

echo "== capture streaming frames and detect transient order =="
TRANSIENT="not-observed"
FRAME_COUNT=0
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  FRAME_COUNT=$((FRAME_COUNT + 1))
  e2e_tui_capture "$E2E_RUN_DIR/tui-frame-${FRAME_COUNT}.txt"
  FRAME_FOLLOW="$(grep -n 'order-repro-followup' "$E2E_RUN_DIR/tui-frame-${FRAME_COUNT}.txt" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  FRAME_QUEUED="$(grep -n 'order repro queued prompt' "$E2E_RUN_DIR/tui-frame-${FRAME_COUNT}.txt" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  if [[ -n "$FRAME_FOLLOW" && -n "$FRAME_QUEUED" ]] && (( FRAME_FOLLOW > FRAME_QUEUED )); then
    TRANSIENT="followup-after-queued"
    break
  fi
  if curl -s "$E2E_BRIDGE_URL/api/session/active" | jq -e '.data == {}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
recovery_wait_idle "$E2E_BRIDGE_URL" "$SID"
echo "  transient order: $TRANSIENT (frames=$FRAME_COUNT)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true
SSE_PID=""

echo "== final exactly-once graph assertions =="
recovery_signature_v2 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v2.json"
recovery_signature_v1 "$E2E_BRIDGE_URL" "$SID" "$E2E_RUN_DIR/final-v1.json"
recovery_assert_sane "$E2E_RUN_DIR/final-v1.json" "$E2E_RUN_DIR/final-v2.json"
if ! jq -e '
    ([ .[] | select(.type == "user") ] | length) == 2
    and ([ .[] | select(.type == "assistant") | .parts[]
          | select(.type == "tool" and .status == "completed" and (.text | length) > 0) ] | length) == 1
    and ([ .[] | select(.type == "assistant") | .parts[]
          | select(.type == "text" and (.text | length) > 0) ] | length) == 2
  ' "$E2E_RUN_DIR/final-v2.json" >/dev/null; then
  echo "e2e: queued-order final graph unexpected" >&2
  cat "$E2E_RUN_DIR/final-v2.json" >&2
  exit 1
fi
echo "  final graph exactly-once (2 users, 1 completed tool, 2 texts)"

echo "== record observed pane order =="
e2e_tui_capture "$E2E_RUN_DIR/tui-final.txt"
FOLLOW_LINE="$(grep -n 'order-repro-followup' "$E2E_RUN_DIR/tui-final.txt" 2>/dev/null | head -1 | cut -d: -f1 || true)"
QUEUED_LINE="$(grep -n 'order repro queued prompt' "$E2E_RUN_DIR/tui-final.txt" 2>/dev/null | head -1 | cut -d: -f1 || true)"
if [[ -n "$FOLLOW_LINE" && -n "$QUEUED_LINE" ]]; then
  if (( FOLLOW_LINE < QUEUED_LINE )); then
    ORDER="followup-before-queued"
  else
    ORDER="followup-after-queued"
  fi
elif [[ -n "$FOLLOW_LINE" ]]; then
  ORDER="followup-visible-queued-not-found"
elif [[ -n "$QUEUED_LINE" ]]; then
  ORDER="queued-visible-followup-not-found"
else
ORDER="neither-marker-visible"
fi
echo "observed pane order: $ORDER (followup line=${FOLLOW_LINE:-na}, queued line=${QUEUED_LINE:-na})"
printf 'scenario=queued-followup\nopencode=1.18.18\ntransient_order=%s\nfinal_order=%s\nframes=%s\nfollowup_line=%s\nqueued_line=%s\n' \
  "$TRANSIENT" "$ORDER" "$FRAME_COUNT" "${FOLLOW_LINE:-na}" "${QUEUED_LINE:-na}" > "$E2E_RUN_DIR/order.txt"

echo "== freeze normalized SSE baseline =="
node scripts/normalize-golden-trace.mjs \
  "$E2E_RUN_DIR/trace.raw" "$E2E_RUN_DIR/golden.sse.jsonl"
mkdir -p "$GOLDEN_DIR"
if [[ -f "$GOLDEN_FILE" ]]; then
  if diff -q "$GOLDEN_FILE" "$E2E_RUN_DIR/golden.sse.jsonl" >/dev/null; then
    echo "  queued-followup golden matches committed baseline"
  elif [[ "${DSH_OC_GOLDEN_OVERWRITE:-0}" == "1" ]]; then
    cp "$E2E_RUN_DIR/golden.sse.jsonl" "$GOLDEN_FILE"
    echo "  queued-followup golden updated"
  elif [[ "${DSH_OC_GOLDEN_STRICT:-0}" != "1" ]]; then
    # The queued user and the follow-up deltas race by design; event order is
    # inherently timing-dependent. The committed trace is a reference
    # recording, not a byte-stable gate; log the delta and continue.
    echo "  note: queued-followup golden differs (expected timing race); recording only"
    diff "$GOLDEN_FILE" "$E2E_RUN_DIR/golden.sse.jsonl" | sed -n '1,12p' || true
  else
    echo "e2e: queued-followup golden differs (structural ABI change?)" >&2
    diff "$GOLDEN_FILE" "$E2E_RUN_DIR/golden.sse.jsonl" | sed -n '1,30p' >&2 || true
    exit 1
  fi
else
  cp "$E2E_RUN_DIR/golden.sse.jsonl" "$GOLDEN_FILE"
  echo "  queued-followup golden baseline written: $GOLDEN_FILE"
fi

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-queued-order-repro: PASSED (transient=$TRANSIENT, final=$ORDER) in $((SECONDS - SCRIPT_START))s"
