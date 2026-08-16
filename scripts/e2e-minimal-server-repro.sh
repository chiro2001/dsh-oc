#!/usr/bin/env bash
# Minimal-server renderer-attribution repro (experiment 1c): boots the
# official opencode 1.18.18 TUI against a scripted, minimal OpenCode server
# (scripts/minimal-oc-server.mjs) that replays the queued-mid-followup
# corpus fixture with no dsh and no real model. Captures streaming pane
# frames and records whether the follow-up text renders below the queued
# card while its first part is above (the transient mis-order). Evidence
# for the renderer-vs-bridge question; not a gate.
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="dsh-oc-minimal-repro"
SERVER_PID=""
SCRIPT_START=$SECONDS
RUN_DIR="${DSH_OC_MINIMAL_RUN_DIR:-/tmp/dsh-oc-minimal-repro}"
mkdir -p "$RUN_DIR"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

FIXTURE="${1:-tests/fixtures/replay/queued-mid-followup.jsonl}"
SID="${2:-session-11111111-1111-4111-8111-111111111111}"
MARKER="${DSH_OC_MINIMAL_MARKER:-QUEUED-MID-SECOND-PROMPT}"
DELAY_MS="${DSH_OC_MINIMAL_DELAY_MS:-120}"
CJK_MODE="${DSH_OC_MINIMAL_CJK:-0}"
RAW_SSE="${DSH_OC_MINIMAL_SSE:-}"
CAPTURE_SECONDS="${DSH_OC_MINIMAL_CAPTURE_SECONDS:-15}"

echo "== start minimal scripted server =="
if [[ -n "$RAW_SSE" ]]; then
  node scripts/minimal-oc-server.mjs --sse "$RAW_SSE" "$SID" "$DELAY_MS" \
    > "$RUN_DIR/server.out" 2> "$RUN_DIR/server.err" &
else
  node scripts/minimal-oc-server.mjs "$FIXTURE" "$SID" "$DELAY_MS" \
    > "$RUN_DIR/server.out" 2> "$RUN_DIR/server.err" &
fi
SERVER_PID=$!
URL=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  if [[ -s "$RUN_DIR/server.out" ]]; then
    URL="$(awk '/^READY /{print $2; exit}' "$RUN_DIR/server.out" 2>/dev/null || true)"
    if [[ -n "$URL" ]]; then break; fi
  fi
  sleep 1
done
if [[ -z "$URL" ]]; then
  echo "e2e: minimal server did not start; stderr:" >&2
  tail -20 "$RUN_DIR/server.err" >&2 || true
  exit 1
fi
echo "  server: $URL"

echo "== boot official opencode TUI against the scripted server =="
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 220 -y 55
tmux send-keys -t "$SESSION" \
  "cd '$PWD' && export TERM=xterm-256color OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 && opencode attach '$URL' -s '$SID' --print-logs 2> '$RUN_DIR/tui.err'" Enter

READY=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  tmux capture-pane -p -t "$SESSION" > "$RUN_DIR/tui-ready.txt" 2>/dev/null || true
  if grep -qaE 'Build ·|ctrl\+p commands|Context' "$RUN_DIR/tui-ready.txt"; then
    READY=1
    break
  fi
  sleep 1
done
if [[ -z "$READY" ]]; then
  echo "e2e: TUI did not render against minimal server" >&2
  tail -30 "$RUN_DIR/tui-ready.txt" >&2 || true
  tail -30 "$RUN_DIR/tui.err" >&2 2>/dev/null || true
  exit 1
fi
echo "  TUI ready"

echo "== capture streaming frames =="
FRAME_COUNT=0
deadline=$((SECONDS + CAPTURE_SECONDS))
while (( SECONDS < deadline )); do
  FRAME_COUNT=$((FRAME_COUNT + 1))
  tmux capture-pane -p -t "$SESSION" > "$RUN_DIR/frame-${FRAME_COUNT}.txt" 2>/dev/null || true
  sleep 0.15
done

echo "== analyze pane order =="
TRANSIENT="not-observed"
SPLIT_FRAME=""
for f in "$RUN_DIR"/frame-*.txt; do
  QUEUED_LINE="$(grep -n "$MARKER" "$f" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  PART1_LINE="$(grep -n 'follow-up part one' "$f" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  PART2_LINE="$(grep -n 'follow-up part two' "$f" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  if [[ -n "$QUEUED_LINE" && -n "$PART1_LINE" && -n "$PART2_LINE" ]] \
    && (( PART1_LINE < QUEUED_LINE )) && (( PART2_LINE > QUEUED_LINE )); then
    TRANSIENT="followup-split-across-queued"
    SPLIT_FRAME="$(basename "$f")"
    break
  fi
done
echo "  transient: $TRANSIENT (frame=${SPLIT_FRAME:-na}, frames=$FRAME_COUNT)"

FINAL="$RUN_DIR/frame-${FRAME_COUNT}.txt"
FQ="$(grep -n "$MARKER" "$FINAL" 2>/dev/null | head -1 | cut -d: -f1 || true)"
F1="$(grep -n 'follow-up part one' "$FINAL" 2>/dev/null | head -1 | cut -d: -f1 || true)"
F2="$(grep -n 'follow-up part two' "$FINAL" 2>/dev/null | head -1 | cut -d: -f1 || true)"
if [[ "$CJK_MODE" == "1" ]]; then
  CJK_BELOW=0
  for f in "$RUN_DIR"/frame-*.txt; do
    QL="$(grep -n "$MARKER" "$f" 2>/dev/null | head -1 | cut -d: -f1 || true)"
    if [[ -n "$QL" ]] && sed -n "$((QL + 1)),\$p" "$f" | rg -qP '[\x{4e00}-\x{9fff}]' 2>/dev/null; then
      CJK_BELOW=$((CJK_BELOW + 1))
    fi
  done
  echo "  cjk-below-queued frames: $CJK_BELOW"
else
  CJK_BELOW="na"
fi
printf 'scenario=minimal-server-queued-mid-followup\nopencode=1.18.18\nfixture=%s\ntransient=%s\nsplit_frame=%s\nframes=%s\nfinal_queued_line=%s\nfinal_part1_line=%s\nfinal_part2_line=%s\ncjk_below_queued_frames=%s\n' \
  "$FIXTURE" "$TRANSIENT" "${SPLIT_FRAME:-na}" "$FRAME_COUNT" "${FQ:-na}" "${F1:-na}" "${F2:-na}" "$CJK_BELOW" \
  > "$RUN_DIR/report.txt"
echo "  report: $RUN_DIR/report.txt"

echo "== stop TUI and server =="
tmux send-keys -t "$SESSION" C-c
sleep 2
tmux kill-session -t "$SESSION" 2>/dev/null || true
kill "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "e2e-minimal-server-repro: PASSED (transient=$TRANSIENT) in $((SECONDS - SCRIPT_START))s"
