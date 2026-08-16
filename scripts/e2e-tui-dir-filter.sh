#!/usr/bin/env bash
# Directory-filter e2e: seed one session in the workspace root and another in
# a sub-project, attach with a relative --dir, and assert only the sub-project
# session appears in the TUI sidebar.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
cleanup() {
  local code=$?
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "tui-dir-filter" "danger-full-access" "success,success" "1"

SUB_DIR="$E2E_WORKDIR/sub-project"
mkdir -p "$SUB_DIR"

echo "== seed root and sub-project sessions =="
E2E_ACTIVE_SESSION="dsh-oc-dir-filter-seed"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

seed_session() {
  local url="$1"
  local text="$2"
  local session
  session="$(curl -s -X POST "$SEED_URL$url" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
  curl -s -X POST "$SEED_URL/session/$session/message" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$text\"}]}" | jq -e '.info.role == "assistant"' >/dev/null
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local got
    got="$(curl -s "$SEED_URL/session/$session/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$got" == *"mock response recovered"* ]]; then break; fi
    sleep 1
  done
  if [[ "$got" != *"mock response recovered"* ]]; then
    echo "e2e: seed reply not seen for $text" >&2
    exit 1
  fi
  echo "$session"
}

SESSION_ROOT="$(seed_session "/session" "dir seed root")"
SUB_URI="$(jq -rn --arg v "$SUB_DIR" '$v|@uri')"
SESSION_SUB="$(seed_session "/session?directory=$SUB_URI" "dir seed sub")"
echo "  root=$SESSION_ROOT sub=$SESSION_SUB"

echo "== restart dsh with relative --dir =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--dir sub-project"
e2e_tui_wait_attach
BRIDGE_URL="$E2E_BRIDGE_URL"

READY_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-dir-filter-ready.txt"
  if grep -qa "Ask anything" "$E2E_RUN_DIR/tui-dir-filter-ready.txt"; then
    READY_HINT="Ask anything"
    break
  fi
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for filtered TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$READY_HINT" ]]; then
  echo "e2e: TUI did not become ready under --dir" >&2
  exit 1
fi
echo "  TUI ready under --dir: $READY_HINT"

echo "== type a prompt and verify it lands in the sub-project =="
tmux send-keys -t "$E2E_TUI_SESSION" "dir filter prompt" Enter

PROMPT_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  for sid in $(curl -s "$BRIDGE_URL/session" | jq -r '.[].id'); do
    local_text="$(curl -s "$BRIDGE_URL/session/$sid/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$local_text" == *"dir filter prompt"* && "$local_text" == *"mock response recovered"* ]]; then
      PROMPT_HINT="$sid"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for filtered prompt: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$PROMPT_HINT" ]]; then
  echo "e2e: filtered prompt did not produce a model turn" >&2
  exit 1
fi

SUB_ABS="$(cd "$SUB_DIR" && pwd)"
MATCHED_SUB="$(curl -s "$BRIDGE_URL/session" | jq -r --arg id "$PROMPT_HINT" '.[] | select(.id == $id) | .directory')"
if [[ "$MATCHED_SUB" != "$SUB_ABS" ]]; then
  echo "e2e: new session directory is '$MATCHED_SUB', expected '$SUB_ABS'" >&2
  exit 1
fi
echo "  new session lands in sub-project: $MATCHED_SUB"

FILTER_URI="$(jq -rn --arg v "$SUB_ABS" '$v|@uri')"
ROOT_IN_FILTER="$(curl -s "$BRIDGE_URL/session?directory=$FILTER_URI" | jq -r '[.[].id] | join(",")')"
if [[ "$ROOT_IN_FILTER" == *"$SESSION_ROOT"* ]]; then
  echo "e2e: root session leaked into the --dir filter" >&2
  exit 1
fi
echo "  root session filtered out ($ROOT_IN_FILTER)"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-dir-filter-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-dir-filter-after.txt"; then
  echo "e2e: shell prompt not restored after filtered TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-dir-filter: PASSED in $((SECONDS - SCRIPT_START))s"
