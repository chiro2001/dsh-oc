#!/usr/bin/env bash
# Shared helpers for the dsh-oc e2e shell drivers.
set -euo pipefail

export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:14514}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:14514}"

E2E_REPO_ROOT="$(git rev-parse --show-toplevel)"
case "$E2E_REPO_ROOT" in
  /home/chiro/projects/dsh-oc/dsh-oc|/home/chiro/projects/dsh-oc/dsh-oc-*)
    ;;
  *)
    echo "e2e: must run from /home/chiro/projects/dsh-oc/dsh-oc-* (got $E2E_REPO_ROOT)" >&2
    exit 2
    ;;
esac
E2E_BRANCH="$(git -C "$E2E_REPO_ROOT" branch --show-current)"
if [[ ! "$E2E_BRANCH" =~ ^(chore-.*|main|feat-.*)$ ]]; then
  echo "e2e: branch must be chore-*/main/feat-* (got $E2E_BRANCH)" >&2
  exit 2
fi

E2E_FAKE_BIN="$E2E_REPO_ROOT/tests/e2e/fake-opencode.sh"
E2E_ENV_JS="$E2E_REPO_ROOT/tests/e2e/env.mjs"
E2E_API_KEY="mock-key"

# Global run facts filled by e2e_new_run.
E2E_RUNID=""
E2E_RUN_DIR=""
E2E_DSH_HOME=""
E2E_WORKDIR=""
E2E_PROFILE_DIR=""
E2E_OVERLAY=""
E2E_SETTINGS=""
E2E_MOCK_PORT=""
E2E_MOCK_PID=""
E2E_MOCK_LOG=""
E2E_MOCK_ERR=""
E2E_PERMISSION_MODE=""
E2E_FAKE_LOG=""
E2E_BRIDGE_URL=""
E2E_TUI_SESSION="dsh-oc-${E2E_BRANCH//[^A-Za-z0-9_-]/_}"

e2e_new_run() {
  local label="$1"
  local permission="$2"
  local sequence="$3"
  local repeat_last="$4"
  local tool_args="${5:-}"
  local tool_name="${6:-}"
  local extra=()
  if [[ -n "$tool_args" ]]; then
    extra+=(--tool-arguments "$tool_args")
  fi
  if [[ -n "$tool_name" ]]; then
    extra+=(--tool-name "$tool_name")
  fi
  local json
  json="$(node "$E2E_ENV_JS" new-run --label "$label" --permission "$permission" --sequence "$sequence" --repeat-last "$repeat_last" "${extra[@]}")"
  E2E_RUNID="$(jq -r .runid <<<"$json")"
  E2E_RUN_DIR="$(jq -r .runDir <<<"$json")"
  E2E_DSH_HOME="$(jq -r .dshHome <<<"$json")"
  E2E_WORKDIR="$(jq -r .workdir <<<"$json")"
  E2E_PROFILE_DIR="$(jq -r .profileDir <<<"$json")"
  E2E_OVERLAY="$(jq -r .overlay <<<"$json")"
  E2E_SETTINGS="$(jq -r .settings <<<"$json")"
  E2E_MOCK_PORT="$(jq -r .mockPort <<<"$json")"
  E2E_MOCK_PID="$(jq -r .mockPid <<<"$json")"
  E2E_MOCK_LOG="$(jq -r .mockLog <<<"$json")"
  E2E_MOCK_ERR="$(jq -r .mockErr <<<"$json")"
  E2E_PERMISSION_MODE="$permission"
  E2E_FAKE_LOG="$E2E_RUN_DIR/fake.log"
  E2E_BRIDGE_URL=""
  echo "e2e: run $E2E_RUNID ready (mock on 127.0.0.1:$E2E_MOCK_PORT)"
}

# Start dsh --profile oc inside tmux with the fake opencode wrapper.
e2e_start_dsh() {
  local session="$1"
  local extra_env="${2:-}"
  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -x 200 -y 50
  local cmd
  cmd="cd '$E2E_WORKDIR' && export DSH_HOME='$E2E_DSH_HOME' DSH_PERMISSION_MODE='$E2E_PERMISSION_MODE' DSH_OC_E2E_MOCK_API_KEY='$E2E_API_KEY' DSH_OC_OPENCODE_BIN='$E2E_FAKE_BIN' DSH_OC_FAKE_LOG='$E2E_FAKE_LOG' $extra_env && dsh --profile oc --patch '$E2E_OVERLAY'"
  tmux send-keys -t "$session" "$cmd" Enter
}

# Poll the fake opencode log until the bridge URL appears (default 90s).
e2e_wait_bridge_url() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if [[ -s "$E2E_FAKE_LOG" ]] && grep -q '^http://127\.0\.0\.1:' "$E2E_FAKE_LOG"; then
      E2E_BRIDGE_URL="$(awk '/^http:\/\/127\.0\.0\.1:/{print; exit}' "$E2E_FAKE_LOG")"
      echo "e2e: bridge URL $E2E_BRIDGE_URL"
      return 0
    fi
    sleep 1
  done
  echo "e2e: bridge did not appear within 90s; fake log:" >&2
  cat "$E2E_FAKE_LOG" >&2 2>/dev/null || true
  return 1
}

# Kill the tmux session and any dsh/fake processes owned by this run.
e2e_stop_dsh() {
  local session="$1"
  tmux kill-session -t "$session" 2>/dev/null || true
  sleep 1
  local pids
  pids="$(ps -eo pid=,args= | awk -v run="$E2E_RUN_DIR" '$0 ~ run && ($0 ~ /dsh --profile/ || $0 ~ /fake-opencode/) { print $1 }')"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(ps -eo pid=,args= | awk -v run="$E2E_RUN_DIR" '$0 ~ run && ($0 ~ /dsh --profile/ || $0 ~ /fake-opencode/) { print $1 }')"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

e2e_stop_run() {
  node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null
}

# ---- real opencode TUI helpers -------------------------------------------

# Start the real opencode TUI through dsh inside tmux; `extra` receives any
# attach flags (e.g. `--session <id>`). `--print-logs` reaches the attach
# command through oc-tui's arg filter.
e2e_tui_start() {
  local extra="${1:-}"
  local extra_env="${2:-}"
  local exit_file="$E2E_RUN_DIR/dsh-exit.txt"
  tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$E2E_TUI_SESSION" -x 240 -y 60
  tmux send-keys -t "$E2E_TUI_SESSION" "stty -a > '$E2E_RUN_DIR/stty-before.txt'" Enter
  sleep 1
  local cmd
  cmd="cd '$E2E_WORKDIR' && export DSH_HOME='$E2E_DSH_HOME' DSH_PERMISSION_MODE='$E2E_PERMISSION_MODE' DSH_OC_E2E_MOCK_API_KEY='$E2E_API_KEY' $extra_env && dsh --profile oc --patch '$E2E_OVERLAY' --print-logs $extra; echo DSH_EXIT=\$? > '$exit_file'"
  tmux send-keys -t "$E2E_TUI_SESSION" "$cmd" Enter
}

# Wait until the real opencode attach process appears (≤60s). Fails if dsh
# exits first or if an `opencode serve` process is found.
e2e_tui_wait_attach() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local dsh_pid
    dsh_pid="$(ps -eo pid=,args= | awk -v overlay="$E2E_OVERLAY" '$0 ~ overlay && $0 ~ /dsh --profile/ { print $1; exit }')"
    local attach_line
    attach_line="$(ps -eo pid=,ppid=,args= | awk -v pid="$dsh_pid" '$2 == pid && $0 ~ /opencode attach http:\/\/127\.0\.0\.1:[0-9]/ { print; exit }')"
    if [[ -n "$attach_line" ]]; then
      if ps -eo pid=,ppid=,args= | awk -v pid="$dsh_pid" '$2 == pid && /opencode serve/ { found=1 } END { exit found ? 0 : 1 }'; then
        echo "e2e: unexpected opencode serve process" >&2
        return 1
      fi
      E2E_BRIDGE_URL="$(awk '{ for (i=1;i<=NF;i++) if ($i ~ /^http:\/\/127\.0\.0\.1:/) { print $i; exit } }' <<<"$attach_line")"
      echo "e2e: opencode attach -> $E2E_BRIDGE_URL"
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited before attach: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
      return 1
    fi
    sleep 1
  done
  echo "e2e: opencode attach did not appear within 60s" >&2
  return 1
}

e2e_tui_capture() {
  local file="$1"
  tmux capture-pane -p -t "$E2E_TUI_SESSION" > "$file" || true
}

# Send `exit` (or fallbacks) and wait for dsh to leave; asserts exit code 0.
e2e_tui_exit() {
  local exit_file="$E2E_RUN_DIR/dsh-exit.txt"
  tmux send-keys -t "$E2E_TUI_SESSION" "exit" Enter
  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    if [[ -s "$exit_file" ]]; then break; fi
    sleep 1
  done
  if [[ ! -s "$exit_file" ]]; then
    tmux send-keys -t "$E2E_TUI_SESSION" "quit" Enter
    deadline=$((SECONDS + 20))
    while (( SECONDS < deadline )); do
      if [[ -s "$exit_file" ]]; then break; fi
      sleep 1
    done
  fi
  if [[ ! -s "$exit_file" ]]; then
    tmux send-keys -t "$E2E_TUI_SESSION" C-d
    deadline=$((SECONDS + 15))
    while (( SECONDS < deadline )); do
      if [[ -s "$exit_file" ]]; then break; fi
      sleep 1
    done
  fi
  if [[ ! -s "$exit_file" ]]; then
    echo "e2e: TUI did not exit after exit/quit/C-d" >&2
    e2e_tui_capture "$E2E_RUN_DIR/tui-stuck.txt"
    return 1
  fi
  grep -q '^DSH_EXIT=0$' "$exit_file"
  echo "  dsh exit: $(cat "$exit_file")"
}

# Verify the terminal is back in cooked mode and the shell prompt is visible.
e2e_tui_after_checks() {
  local before="$E2E_RUN_DIR/stty-before.txt"
  local after="$E2E_RUN_DIR/stty-after.txt"
  sleep 1
  tmux send-keys -t "$E2E_TUI_SESSION" "stty -a > '$after'" Enter
  sleep 1
  if [[ ! -f "$after" ]]; then
    echo "e2e: stty-after missing" >&2
    return 1
  fi
  grep -q ' icanon' "$before"
  grep -q ' echo' "$before"
  if grep -q -- '-icanon' "$after" || ! grep -q ' icanon' "$after"; then
    echo "e2e: terminal still in raw mode after exit" >&2
    return 1
  fi
  if ! grep -q ' echo' "$after"; then
    echo "e2e: echo still disabled after exit" >&2
    return 1
  fi
  echo "  terminal cooked mode restored (icanon+echo)"
}
