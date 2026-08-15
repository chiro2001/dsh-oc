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
    trap 'exit 0' TERM INT
    while :; do
      read -r -t 3600 < /dev/null || true
    done
    ;;
esac

exit 1
