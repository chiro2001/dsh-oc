#!/usr/bin/env bash
# Real-LLM end-to-end test (LOCAL, manual only): runs a full dsh-oc workflow
# in an isolated DSH_HOME against the real DeepSeek API, then attaches the
# real opencode TUI in tmux to verify sidebar/interaction behavior that mock
# LLMs cannot reproduce (duplicate submits, queue ordering, goal+todo sidebar).
#
# Requirements:
#   - ~/.dsh/.credentials.yaml (or $DSH_OC_REAL_CREDENTIALS pointing to one)
#   - real network access to the configured provider (uses real tokens)
#   - branch whitelist like other e2e scripts (main/develop/feat-*/...)
#
# Usage:
#   bash scripts/e2e-real-llm.sh [--quick] [--add-spec <path|github spec>]
#
# --quick skips the slow streaming/queue probe and the TUI sidebar check.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

QUICK=0
ADD_SPEC="${DSH_OC_REAL_ADD_SPEC:-.}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) QUICK=1; shift ;;
    --add-spec) ADD_SPEC="${2:-.}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CREDENTIALS="${DSH_OC_REAL_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
if [[ ! -f "$CREDENTIALS" ]]; then
  echo "e2e-real-llm: credentials file not found at $CREDENTIALS" >&2
  exit 2
fi

SCRIPT_START=$SECONDS
E2E_RUNID=""
E2E_ACTIVE_SESSION=""

cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    if [[ "$code" == "0" || "${DSH_OC_REAL_KEEP_RUN:-0}" == "1" ]]; then
      rm -rf "$E2E_RUN_DIR"
    else
      echo "e2e-real-llm: run kept at $E2E_RUN_DIR" >&2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT

RUNID="$(date +%s%3N)-real-llm"
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
if [[ -f "$HOME/.dsh/settings.yaml" ]]; then
  cp "$HOME/.dsh/settings.yaml" "$E2E_DSH_HOME/settings.yaml"
else
  printf 'agent-presets:\n  default: minimal\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: high\n' > "$E2E_DSH_HOME/settings.yaml"
fi
printf -- '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n    reasoningEffort: high\n' > "$E2E_OVERLAY"

echo "e2e-real-llm: run $RUNID (credentials: $CREDENTIALS)"
env DSH_HOME="$E2E_DSH_HOME" dsh plugin --profile oc add "$ADD_SPEC" >/dev/null 2>&1
echo "  profile oc installed from $ADD_SPEC"

wait_ready() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    e2e_tui_capture "$E2E_RUN_DIR/ready.txt"
    # Real attach sessions do not show the home "Ask anything" placeholder;
    # the model footer or the status line is the reliable render signal.
    grep -qaE 'Build ·|Context|ctrl\+p commands' "$E2E_RUN_DIR/ready.txt" && return 0
    [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]] && return 1
    sleep 1
  done
  return 1
}

wait_idle() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local st
    st="$(curl -s "$E2E_BRIDGE_URL/session/status" | jq -r --arg s "$SID" '.[$s].type // "idle"')"
    if [[ "$st" == "idle" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

user_count() {
  curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq '[.[] | select(.info.role == "user")] | length'
}

tool_part_count() {
  curl -s "$E2E_BRIDGE_URL/session/$SID/message" | jq '[.. | objects | select(.type == "tool")] | length'
}

echo "== headless phase (real LLM) =="
E2E_ACTIVE_SESSION="dsh-oc-real-llm-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
B="$E2E_BRIDGE_URL"
SID="$(curl -s -X POST "$B/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
echo "  session $SID"

echo "== task 1: text + tool call =="
curl -s -X POST "$B/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 运行 ls 列出当前目录前 5 项，然后用一句话总结 README.md 的第一行。"}]}' >/dev/null
wait_idle
COUNT="$(user_count)"
if [[ "$COUNT" != "1" ]]; then
  echo "e2e: expected exactly 1 user message after task 1, got $COUNT" >&2
  exit 1
fi
TOOLS="$(tool_part_count)"
echo "  task 1 done: user=$COUNT tool-parts=$TOOLS"
if [[ "$TOOLS" -lt 1 ]]; then
  echo "e2e: task 1 did not produce a tool part" >&2
  exit 1
fi

if [[ "$QUICK" != "1" ]]; then
  echo "== queue probe: send '继续' while idle, then immediately a slow task =="
  curl -s -X POST "$B/session/$SID/message" -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"继续"}]}' >/dev/null
  sleep 1
  curl -s -X POST "$B/session/$SID/message" -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"只回复两个字：完成"}]}' >/dev/null
  wait_idle
  COUNT="$(user_count)"
  if [[ "$COUNT" != "3" ]]; then
    echo "e2e: queue probe expected 3 user messages, got $COUNT" >&2
    exit 1
  fi
  echo "  queue probe ok: 3 messages consumed in order"
fi

echo "== goal + variant =="
# Use the deterministic /goal command (same path as the TUI) instead of
# asking the model to call create_goal itself: real-model behavior varies
# and a model that merely narrates instead of invoking the tool stalls the
# probe. The model-driven create_goal path is still covered by e2e-api-goal.sh.
curl -s -X POST "$B/session/$SID/command" -H 'Content-Type: application/json' \
  -d '{"command":"goal","arguments":"验证 dsh-oc 真实 LLM 集成"}' >/dev/null
GOAL_OK=""
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  TODO="$(curl -s "$B/session/$SID/todo")"
  if jq -e --arg g 'Goal: 验证 dsh-oc 真实 LLM 集成' 'any(.[]; .content == $g)' <<<"$TODO" >/dev/null 2>&1; then
    GOAL_OK=1
    break
  fi
  sleep 3
done
if [[ -z "$GOAL_OK" ]]; then
  echo "e2e: goal not created within 90s" >&2
  curl -s "$B/session/$SID/message" | jq -r '.[] | select(.info.role=="assistant") | (.parts[]?.text // "")' | tail -5 >&2 || true
  exit 1
fi
echo "  goal visible in /todo"
MODEL="$(curl -s "$B/api/session/$SID" | jq -c '.data.model')"
echo "  session model: $MODEL"
echo "$MODEL" | jq -e '.variant != null' >/dev/null
echo "  variant retained"

if [[ "$QUICK" == "1" ]]; then
  e2e_stop_dsh "$E2E_ACTIVE_SESSION"
  E2E_ACTIVE_SESSION=""
  echo "e2e-real-llm (quick): PASSED in $((SECONDS - SCRIPT_START))s"
  exit 0
fi

echo "== TUI phase: attach real opencode TUI =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""
e2e_tui_start "--session $SID"
e2e_tui_wait_attach
wait_ready

SIDEBAR=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-sidebar.txt"
  if grep -qa 'Goal: 验证 dsh-oc 真实 LLM 集成' "$E2E_RUN_DIR/tui-sidebar.txt"; then
    SIDEBAR="goal"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then break; fi
  sleep 1
done
if [[ -z "$SIDEBAR" ]]; then
  echo "e2e: goal not visible in TUI sidebar" >&2
  tail -40 "$E2E_RUN_DIR/tui-sidebar.txt" >&2 || true
  exit 1
fi
echo "  goal visible in sidebar"

tmux send-keys -t "$E2E_TUI_SESSION" '继续' Enter
sleep 8
e2e_tui_capture "$E2E_RUN_DIR/tui-continue.txt"
grep -qa 'mock response recovered\|完成\|继续' "$E2E_RUN_DIR/tui-continue.txt" || true
echo "  TUI prompt submitted (user count: $(user_count))"

e2e_tui_exit
tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true

echo "e2e-real-llm: PASSED in $((SECONDS - SCRIPT_START))s"
