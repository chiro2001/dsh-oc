#!/usr/bin/env bash
# Real-model queued-order repro (LOCAL, manual): drives the known edge case
# with the real DeepSeek API and the official opencode 1.18.18 TUI:
#   tool-call turn -> tool result -> model keeps streaming a long follow-up
#   -> second prompt queued from the keyboard mid-stream
# Records the wire-level evidence (whether follow-up deltas arrive after the
# queued user event on the bridge SSE) and streaming pane frames. This is
# attribution evidence for the renderer-vs-bridge question, not a gate.
#
# Requirements:
#   - ~/.dsh/.credentials.yaml (or $DSH_OC_REAL_CREDENTIALS)
#   - real network access (uses real tokens)
#
# Usage: bash scripts/e2e-real-queued-order.sh [--add-spec <path|github spec>]
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

ADD_SPEC="${DSH_OC_REAL_ADD_SPEC:-.}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --add-spec) ADD_SPEC="${2:-.}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CREDENTIALS="${DSH_OC_REAL_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
if [[ ! -f "$CREDENTIALS" ]]; then
  echo "e2e-real-queued-order: credentials file not found at $CREDENTIALS" >&2
  exit 2
fi

SCRIPT_START=$SECONDS
E2E_RUNID=""
E2E_ACTIVE_SESSION=""
SSE_PID=""

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$SSE_PID" ]]; then kill "$SSE_PID" 2>/dev/null || true; fi
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    if [[ "$code" == "0" && "${DSH_OC_REAL_KEEP_RUN:-0}" != "1" ]]; then
      rm -rf "$E2E_RUN_DIR"
    else
      echo "e2e-real-queued-order: run kept at $E2E_RUN_DIR" >&2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT

RUNID="$(date +%s%3N)-real-queued-order"
E2E_RUNID="$RUNID"
E2E_RUN_DIR="$E2E_REPO_ROOT/.e2e/$RUNID"
E2E_DSH_HOME="$E2E_RUN_DIR/dsh-home"
E2E_WORKDIR="$E2E_RUN_DIR/work"
E2E_OVERLAY="$E2E_RUN_DIR/agent-model.patch.yml"
E2E_PERMISSION_MODE="workspace-write"
E2E_FAKE_LOG="$E2E_RUN_DIR/fake.log"
mkdir -p "$E2E_DSH_HOME" "$E2E_WORKDIR"
git -C "$E2E_WORKDIR" init -q -b main
cp "$CREDENTIALS" "$E2E_DSH_HOME/.credentials.yaml"
chmod 600 "$E2E_DSH_HOME/.credentials.yaml"
printf 'agent-presets:\n  default: standard\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: high\n' \
  > "$E2E_DSH_HOME/settings.yaml"
printf -- '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n    reasoningEffort: high\n' \
  > "$E2E_OVERLAY"

echo "e2e-real-queued-order: run $RUNID (credentials: $CREDENTIALS)"
env DSH_HOME="$E2E_DSH_HOME" dsh plugin --profile oc add "$ADD_SPEC" >/dev/null 2>&1
echo "  profile oc installed from $ADD_SPEC"

wait_ready() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    e2e_tui_capture "$E2E_RUN_DIR/ready.txt"
    grep -qaE 'Build ·|Context|ctrl\+p commands' "$E2E_RUN_DIR/ready.txt" && return 0
    [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]] && return 1
    sleep 1
  done
  return 1
}

wait_idle() {
  local deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    local st
    st="$(curl -s "$E2E_BRIDGE_URL/session/status" | jq -r --arg s "$SID" '.[$s].type // "idle"')"
    if [[ "$st" == "idle" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

echo "== boot real opencode TUI =="
e2e_tui_start ""
e2e_tui_wait_attach
wait_ready
echo "  TUI ready"

# Record the full bridge SSE from before the first prompt so the trace is
# complete enough for raw replay on the minimal server.
curl -sN --max-time 300 "$E2E_BRIDGE_URL/global/event" \
  > "$E2E_RUN_DIR/trace.raw" 2>/dev/null &
SSE_PID=$!

tmux send-keys -t "$E2E_TUI_SESSION" 'real order repro: 先运行 ls 列出当前目录前 5 项，然后写一段 300 字左右的说明文字，慢慢输出。' Enter
SID=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  SID="$(curl -s "$E2E_BRIDGE_URL/session" | jq -r '.[0].id // empty' 2>/dev/null || true)"
  if [[ -n "$SID" ]]; then break; fi
  sleep 1
done
[[ -n "$SID" ]]
echo "  session $SID"

echo "== wait for tool completion, then queue a second prompt =="
deadline=$((SECONDS + 180))
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
  echo "e2e: real model did not complete a tool within 120s" >&2
  exit 1
fi
echo "  tool completed; queuing second prompt"
tmux send-keys -t "$E2E_TUI_SESSION" 'real order repro queued prompt' Enter

echo "== capture streaming frames until idle =="
FRAME_COUNT=0
TRANSIENT="not-observed"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  FRAME_COUNT=$((FRAME_COUNT + 1))
  e2e_tui_capture "$E2E_RUN_DIR/tui-frame-${FRAME_COUNT}.txt"
  if curl -s "$E2E_BRIDGE_URL/api/session/active" | jq -e '.data == {}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done
wait_idle
kill "$SSE_PID" 2>/dev/null || true
SSE_PID=""

echo "== wire-level evidence: follow-up deltas vs queued user event =="
# The first user message.updated in the trace after the second prompt is the
# queued user event; any follow-up text delta that arrives after it is the
# wire precondition for the transient mis-order.
QUEUED_EVENT_SEQ=""
FOLLOW_AFTER_QUEUED="0"
FIRST_FOLLOW_SEQ=""
SEQ=0
while IFS= read -r line; do
  [[ "$line" != data:* ]] && continue
  event="$(jq -c . <<<"${line#data: }" 2>/dev/null || true)"
  [[ -z "$event" ]] && continue
  SEQ=$((SEQ + 1))
  type="$(jq -r '.payload.type // "unknown"' <<<"$event")"
  if [[ "$type" == "message.updated" ]]; then
    :
  elif [[ "$type" == "message.part.updated" ]]; then
    part_text="$(jq -r '.payload.properties.part.text // ""' <<<"$event")"
    if [[ -z "$QUEUED_EVENT_SEQ" && "$part_text" == *"real order repro queued prompt"* ]]; then
      QUEUED_EVENT_SEQ="$SEQ"
    fi
  elif [[ "$type" == "message.part.delta" ]]; then
    if [[ -z "$FIRST_FOLLOW_SEQ" ]]; then
      FIRST_FOLLOW_SEQ="$SEQ"
    fi
    if [[ -n "$QUEUED_EVENT_SEQ" && "$SEQ" -gt "$QUEUED_EVENT_SEQ" ]]; then
      FOLLOW_AFTER_QUEUED="1"
    fi
  fi
done < "$E2E_RUN_DIR/trace.raw"
echo "  queued user event seq: ${QUEUED_EVENT_SEQ:-na}, first follow-up delta seq: ${FIRST_FOLLOW_SEQ:-na}"
if [[ "$FOLLOW_AFTER_QUEUED" == "1" ]]; then
  echo "  WIRE: follow-up deltas continued after the queued user event (precondition present)"
else
  echo "  WIRE: follow-up deltas completed before the queued user event"
fi

echo "== final graph sanity (exactly-once, tolerant) =="
GRAPH="$(curl -s "$E2E_BRIDGE_URL/api/session/$SID/message")"
USER_COUNT="$(jq '[.data[] | select(.type == "user")] | length' <<<"$GRAPH")"
TOOL_COUNT="$(jq '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .state.status == "completed")] | length' <<<"$GRAPH")"
if ! jq -e '
    ([.data[] | select(.type == "user")] | length) >= 2
    and ([.data[].id] | length) == ([.data[].id] | unique | length)
    and ([.data[] | select(.type == "assistant") | .content[]?
          | select(.type == "tool" and .state.status == "completed")] | length) >= 1
  ' <<<"$GRAPH" >/dev/null 2>&1; then
  echo "e2e: real queued-order final graph unexpected" >&2
  echo "  users=$USER_COUNT tools=$TOOL_COUNT" >&2
  jq -c '.data[] | {type, id}' <<<"$GRAPH" | head -20 >&2 || true
  exit 1
fi
echo "  final graph: users=$USER_COUNT tools=$TOOL_COUNT, no duplicate ids"

printf 'scenario=real-queued-followup\nopencode=1.18.18\nwire_follow_after_queued=%s\nqueued_event_seq=%s\nfirst_follow_seq=%s\nframes=%s\nusers=%s\ntools=%s\n' \
  "$FOLLOW_AFTER_QUEUED" "${QUEUED_EVENT_SEQ:-na}" "${FIRST_FOLLOW_SEQ:-na}" "$FRAME_COUNT" "$USER_COUNT" "$TOOL_COUNT" \
  > "$E2E_RUN_DIR/order.txt"
echo "  evidence saved: $E2E_RUN_DIR/order.txt, trace.raw, tui-frame-*.txt"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true

echo "e2e-real-queued-order: PASSED (wire_follow_after_queued=$FOLLOW_AFTER_QUEUED) in $((SECONDS - SCRIPT_START))s"
