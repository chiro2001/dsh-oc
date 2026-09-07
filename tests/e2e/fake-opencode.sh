#!/usr/bin/env bash
# Fake opencode binary used by the API e2e: answers `--version` and records
# every `attach` argument into $DSH_OC_FAKE_LOG, then sleeps until signalled.
set -u

case "${1:-}" in
  --version)
    printf '%s\n' '1.18.18'
    exit 0
    ;;
  attach)
    log="${DSH_OC_FAKE_LOG:?DSH_OC_FAKE_LOG must be set}"
    printf '%s\n' "$@" > "$log"
    sleep_pid=''
    cleanup() {
      trap - TERM INT
      if [[ -n "$sleep_pid" ]]; then
        kill "$sleep_pid" 2>/dev/null || true
        wait "$sleep_pid" 2>/dev/null || true
      fi
      exit 0
    }
    trap cleanup TERM INT
    while :; do
      # `read -t ... < /dev/null` returns EOF immediately and spins at 100%
      # CPU. Keep a real child wait instead; signals are handled by cleanup.
      sleep 3600 &
      sleep_pid=$!
      status=0
      wait "$sleep_pid" || status=$?
      sleep_pid=''
      [[ "$status" == 0 ]] || exit 0
    done
    ;;
esac

exit 1
