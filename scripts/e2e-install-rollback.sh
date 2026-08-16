#!/usr/bin/env bash
# Immutable install/upgrade/rollback drill (experiment 2, LOCAL/manual):
# installs the candidate package from a remote GitHub full SHA, runs a real
# TUI smoke against that install, then reinstalls the previous spec and runs
# the same smoke again. Also probes in-place re-add behavior inside one
# profile and records the resolved package version before/after.
#
# Caveat: until the package version is bumped to rc.2, pnpm may reuse the
# same version for different refs, so the in-place probe only exercises the
# command path; cache-safe immutable verification requires a version bump.
#
# Usage:
#   bash scripts/e2e-install-rollback.sh \
#     [--candidate github:chiro2001/dsh-oc#<full-sha>] \
#     [--previous <path|github spec>] \
#     [--smoke e2e-tui-turn.sh] [--skip-smoke]
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
HEAD_SHA="$(git rev-parse HEAD)"
CANDIDATE="${DSH_OC_INSTALL_CANDIDATE:-github:chiro2001/dsh-oc#$HEAD_SHA}"
PREVIOUS="${DSH_OC_INSTALL_PREVIOUS:-$REPO_ROOT}"
SMOKE="e2e-tui-turn.sh"
SKIP_SMOKE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate) CANDIDATE="${2:-}"; shift 2 ;;
    --previous) PREVIOUS="${2:-}"; shift 2 ;;
    --smoke) SMOKE="${2:-}"; shift 2 ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# The candidate must already be reachable on GitHub for a real install.
CAND_REF="$(rg -o '#[0-9a-f]{40}' <<<"$CANDIDATE" | tr -d '#' || true)"
if [[ -z "$CAND_REF" ]]; then
  echo "e2e-install-rollback: --candidate must be a full-SHA github spec (got $CANDIDATE)" >&2
  exit 2
fi
if ! git ls-remote origin 2>/dev/null | awk -v sha="$CAND_REF" '$1 == sha { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "e2e-install-rollback: candidate SHA $CAND_REF is not on origin; push it first" >&2
  exit 2
fi
echo "== candidate: $CANDIDATE =="
echo "== previous : $PREVIOUS =="

install_check() {
  local spec="$1"
  local label="$2"
  local home="$3"
  local version_before="$4"
  echo "-- install $label ($spec) --"
  DSH_HOME="$home" dsh plugin --profile oc add "$spec" >/dev/null
  local profile="$home/profiles/oc"
  local version
  version="$(node -p "require('$profile/node_modules/@chiro2001/dsh-oc/package.json').version" 2>/dev/null || echo 'missing')"
  if ! DSH_HOME="$home" dsh --profile oc --dump-config | grep -q '# == @chiro2001/dsh-oc'; then
    echo "FAIL: $label bundle block missing from dump-config" >&2
    exit 1
  fi
  echo "  $label resolved version: $version (before: $version_before)"
  if [[ -n "$version_before" && "$version" != "$version_before" ]]; then
    echo "  note: version changed $version_before -> $version"
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-oc-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

install_check "$CANDIDATE" "candidate" "$TMP/candidate-home" ""
if [[ "$SKIP_SMOKE" != "1" ]]; then
  echo "-- smoke with candidate install --"
  DSH_OC_E2E_ADD_SPEC="$CANDIDATE" bash "scripts/$SMOKE"
fi

# In-place re-add probe: same profile, previous spec.
install_check "$PREVIOUS" "in-place rollback" "$TMP/candidate-home" \
  "$(node -p "require('$TMP/candidate-home/profiles/oc/node_modules/@chiro2001/dsh-oc/package.json').version" 2>/dev/null || echo missing)"
if [[ "$SKIP_SMOKE" != "1" ]]; then
  echo "-- smoke with previous spec --"
  DSH_OC_E2E_ADD_SPEC="$PREVIOUS" bash "scripts/$SMOKE"
fi

echo "e2e-install-rollback: PASSED"
