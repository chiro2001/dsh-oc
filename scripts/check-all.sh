#!/usr/bin/env bash
# One-shot quality gate: typecheck, unit tests, protocol probe, perf smoke,
# and optionally the full e2e suite (--e2e) or a large perf run (--scale N).
set -euo pipefail
cd "$(dirname "$0")/.."

SCALE=""
E2E=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --e2e) E2E=1; shift ;;
    --scale) SCALE="${2:-5000}"; shift 2 ;;
    --scale=*) SCALE="${1#--scale=}"; shift ;;
    *) shift ;;
  esac
done

echo "== typecheck =="
pnpm typecheck

echo "== unit tests =="
pnpm test

echo "== protocol probe =="
pnpm run probe

echo "== perf smoke (200 sessions) =="
node scripts/perf.mjs --sessions 200 --quiet >/dev/null

if [[ -n "$SCALE" ]]; then
  echo "== perf scale (${SCALE} sessions) =="
  node scripts/perf.mjs --sessions "$SCALE" --quiet >/dev/null
fi

if [[ "$E2E" == "1" ]]; then
  echo "== e2e suite =="
  FAILED=0
  STABLE_E2E="e2e-api.sh e2e-api-attachment.sh e2e-cli-bin.sh e2e-tui-boot.sh e2e-tui-turn.sh e2e-tui-tools.sh \
    e2e-tui-command.sh e2e-api-goal.sh e2e-tui-goal.sh e2e-tui-goal-command.sh e2e-tui-brand.sh \
    e2e-tui-dir.sh e2e-tui-fork.sh e2e-tui-offline.sh e2e-tui-version-lock.sh \
    e2e-tui-help.sh e2e-tui-print-logs.sh e2e-api-permission.sh \
    e2e-tui-permission.sh e2e-tui-permission-ext.sh e2e-tui-queue.sh \
    e2e-tui-agent-tab.sh e2e-tui-agent-lock.sh e2e-tui-queue-live.sh e2e-recovery-consistency.sh"
  if [[ "${CI_E2E_SUBSET:-}" == "api" ]]; then
    E2E_SCRIPTS="e2e-api.sh e2e-api-goal.sh"
  elif [[ "${CI_E2E_SUBSET:-}" == "1" ]]; then
    # Optional parallel sharding for CI: each shard runs a round-robin slice
    # of the stable suite, so two parallel runners cut wall-clock time.
    SHARD_COUNT="${CI_E2E_SHARDS:-1}"
    SHARD_INDEX="${CI_E2E_SHARD:-0}"
    E2E_SCRIPTS=""
    _i=0
    for _s in $STABLE_E2E; do
      if (( _i % SHARD_COUNT == SHARD_INDEX )); then
        E2E_SCRIPTS+="$_s "
      fi
      _i=$((_i + 1))
    done
  else
    E2E_SCRIPTS="$STABLE_E2E e2e-tui-timestamps.sh e2e-tui-mini.sh e2e-tui-skill.sh e2e-tui-continue.sh e2e-tui-dir-filter.sh e2e-tui-abort.sh"
  fi
  E2E_TIMEOUT="${E2E_TIMEOUT:-300}"
  run_e2e_script() {
    local script="$1"
    local log="$2"
    set +e
    timeout -k 15 "$E2E_TIMEOUT" bash "scripts/$script" > "$log" 2>&1
    local rc=$?
    if [[ "$rc" == "124" || "$rc" == "137" ]]; then
      echo "e2e: $script timed out after ${E2E_TIMEOUT}s" >> "$log"
    fi
    return "$rc"
  }
  for s in $E2E_SCRIPTS; do
    log="/tmp/check-all-$s.log"
    set +e
    run_e2e_script "$s" "$log"
    rc=$?
    set -e
    out="$(tail -1 "$log")"
    if [[ "$rc" == "0" && "$out" == *PASSED* ]]; then
      echo "PASS $s"
    else
      # CI runners occasionally hit permission/timing flakes; one retry keeps
      # the gate meaningful while still surfacing genuinely broken suites.
      echo "RETRY $s (first run rc=$rc)"
      cp "$log" "$log.first" 2>/dev/null || true
      set +e
      run_e2e_script "$s" "$log"
      rc=$?
      set -e
      out="$(tail -1 "$log")"
      if [[ "$rc" == "0" && "$out" == *PASSED* ]]; then
        echo "PASS $s (after retry; first-attempt log: $log.first)"
      else
        echo "FAIL $s (rc=$rc) :: $out"
        tail -40 "$log" >&2
        FAILED=1
      fi
    fi
  done
  if [[ "$FAILED" != "0" ]]; then
    echo "check-all: E2E FAILED" >&2
    exit 1
  fi
fi

echo "check-all: PASSED"
