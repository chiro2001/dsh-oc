#!/usr/bin/env bash
# Shared helpers for the dsh-oc e2e shell drivers.
set -euo pipefail

export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:14514}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:14514}"
# Bridge and opencode attach traffic targets 127.0.0.1; it must never be
# routed through the outer proxy (CI runners have no local proxy service).
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export no_proxy="$NO_PROXY"

E2E_REPO_ROOT="$(git rev-parse --show-toplevel)"
case "$E2E_REPO_ROOT" in
  */dsh-oc|*/dsh-oc-*)
    ;;
  *)
    echo "e2e: must run from a dsh-oc checkout (got $E2E_REPO_ROOT)" >&2
    exit 2
    ;;
esac
E2E_BRANCH="$(git -C "$E2E_REPO_ROOT" branch --show-current)"
if [[ -n "$E2E_BRANCH" && ! "$E2E_BRANCH" =~ ^(chore-.*|fix-.*|docs-.*|perf-.*|test-.*|main|develop|feat-.*)$ ]]; then
  echo "e2e: branch must be chore-*/fix-*/docs-*/perf-*/test-*/main/develop/feat-* (got $E2E_BRANCH)" >&2
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
E2E_TUI_ATTACH_PID=""
E2E_TUI_IO_MONITOR_PID=""
E2E_TUI_IO_MONITOR_LOG=""
E2E_TUI_IO_MONITOR_WARN=""
E2E_TUI_IO_MONITOR_SEQ=0

# curl with retries for transient connect failures (CI/timing robustness).
e2e_curl() {
  local tries="${E2E_CURL_TRIES:-3}"
  local rc=0
  for _ in $(seq 1 "$tries"); do
    curl "$@" && return 0
    rc=$?
    sleep 1
  done
  return "$rc"
}

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
  e2e_tui_io_monitor_cleanup
  E2E_TUI_ATTACH_PID=""
  E2E_TUI_IO_MONITOR_LOG=""
  E2E_TUI_IO_MONITOR_WARN=""
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

# Stop only the optional observer owned by this shell helper. The observed
# opencode PID is deliberately never a cleanup target; in normal operation the
# observer exits itself when that process disappears.
e2e_tui_io_monitor_cleanup() {
  local monitor_pid="${E2E_TUI_IO_MONITOR_PID:-}"
  [[ -n "$monitor_pid" ]] || return 0
  local deadline=$((SECONDS + 5))
  while kill -0 "$monitor_pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      kill "$monitor_pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done
  wait "$monitor_pid" 2>/dev/null || true
  E2E_TUI_IO_MONITOR_PID=""
}

e2e_tui_io_monitor_start() {
  local attach_pid="$1"
  [[ "${DSH_OC_E2E_MONITOR_IO:-0}" == 1 ]] || return 0
  [[ "$attach_pid" =~ ^[0-9]+$ ]] || {
    echo "e2e: refusing I/O monitor for invalid attach PID: $attach_pid" >&2
    return 1
  }
  e2e_tui_io_monitor_cleanup

  local interval="${DSH_OC_E2E_MONITOR_INTERVAL:-0.25}"
  local read_threshold="${DSH_OC_E2E_MONITOR_READ_THRESHOLD:-33554432}"
  local stem="$E2E_RUN_DIR/opencode-attach-${attach_pid}"
  local suffix=0
  local log_file="${stem}.io.tsv"
  local warning_file="${stem}.io.warn"
  # A PID normally appears once per run. If a test reuses a PID, retain both
  # observations instead of truncating the first one.
  while [[ -e "$log_file" || -e "$warning_file" ]]; do
    suffix=$((suffix + 1))
    log_file="${stem}-${suffix}.io.tsv"
    warning_file="${stem}-${suffix}.io.warn"
  done
  : > "$warning_file"

  # No --start/--terminate-owned here: this is an observer for the exact
  # opencode child found by e2e_tui_wait_attach. tee keeps warnings visible in
  # the e2e stderr while preserving them beside the run's TSV log.
  "$E2E_REPO_ROOT/scripts/monitor-process-io.sh" \
    --pid "$attach_pid" \
    --include-descendants \
    --interval "$interval" \
    --read-threshold "$read_threshold" \
    --log "$log_file" \
    2> >(tee -a "$warning_file" >&2) &
  E2E_TUI_IO_MONITOR_PID=$!
  E2E_TUI_IO_MONITOR_LOG="$log_file"
  E2E_TUI_IO_MONITOR_WARN="$warning_file"
  E2E_TUI_IO_MONITOR_SEQ=$((E2E_TUI_IO_MONITOR_SEQ + 1))
  echo "e2e: observing opencode attach pid=$attach_pid (log=$log_file)"
}

# Start the real opencode TUI through dsh inside tmux; `extra` receives any
# attach flags (e.g. `--session <id>`). `--print-logs` reaches the attach
# command through oc-tui's arg filter.
e2e_tui_start() {
  local extra="${1:-}"
  local extra_env="${2:-}"
  local exit_file="$E2E_RUN_DIR/dsh-exit.txt"
  e2e_tui_io_monitor_cleanup
  E2E_TUI_ATTACH_PID=""
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
    local attach_info attach_pid attach_line
    attach_info="$(ps -eo pid=,ppid=,args= | awk -v pid="$dsh_pid" '
      $2 == pid {
        command = $0
        sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", command)
        if (command ~ /(^|[[:space:]\/])opencode[[:space:]]+attach[[:space:]]+http:\/\/127\.0\.0\.1:[0-9]+([[:space:]]|$)/) {
          print $1 "\t" command
          exit
        }
      }')"
    if [[ -n "$attach_info" ]]; then
      attach_pid="${attach_info%%$'\t'*}"
      attach_line="${attach_info#*$'\t'}"
      if [[ ! "$attach_pid" =~ ^[0-9]+$ ]]; then
        echo "e2e: parsed an invalid opencode attach PID: $attach_pid" >&2
        return 1
      fi
      if ps -eo pid=,ppid=,args= | awk -v pid="$dsh_pid" '$2 == pid && /opencode serve/ { found=1 } END { exit found ? 0 : 1 }'; then
        echo "e2e: unexpected opencode serve process" >&2
        return 1
      fi
      E2E_BRIDGE_URL="$(awk '{ for (i=1;i<=NF;i++) if ($i ~ /^http:\/\/127\.0\.0\.1:/) { print $i; exit } }' <<<"$attach_line")"
      E2E_TUI_ATTACH_PID="$attach_pid"
      echo "e2e: opencode attach -> $E2E_BRIDGE_URL"
      e2e_tui_io_monitor_start "$attach_pid"
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "e2e: dsh exited before attach: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
      cat "$E2E_RUN_DIR/dsh-stderr.txt" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  echo "e2e: opencode attach did not appear within 60s" >&2
  tmux capture-pane -p -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
  cat "$E2E_RUN_DIR/dsh-exit.txt" >&2 2>/dev/null || true
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
  e2e_tui_io_monitor_cleanup
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
