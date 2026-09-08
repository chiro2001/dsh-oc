#!/usr/bin/env bash
# Update the local dsh profile's dsh-oc install to a GitHub branch/tag and
# verify the resolved commit plus the dsh-oc --version dual output.
#
# Usage: bash scripts/update-local-install.sh [branch|tag]  (default: develop)
set -euo pipefail
cd "$(dirname "$0")/.."

resolve_dsh_oc_commit() {
  local lock="$1"
  if [[ ! -f "$lock" ]]; then
    echo "dsh-oc lock resolver: lockfile not found: $lock" >&2
    return 2
  fi

  local raw_matches
  local scan_rc
  if command -v rg >/dev/null 2>&1; then
    if raw_matches="$(rg -o 'codeload\.github\.com/chiro2001/dsh-oc/tar\.gz/[0-9a-f]{40}' "$lock")"; then
      scan_rc=0
    else
      scan_rc=$?
      if [[ "$scan_rc" != "1" ]]; then
        echo "dsh-oc lock resolver: rg failed (rc=$scan_rc)" >&2
        return 2
      fi
      raw_matches=''
    fi
  elif command -v grep >/dev/null 2>&1; then
    if raw_matches="$(grep -oE 'codeload\.github\.com/chiro2001/dsh-oc/tar\.gz/[0-9a-f]{40}' "$lock")"; then
      scan_rc=0
    else
      scan_rc=$?
      if [[ "$scan_rc" != "1" ]]; then
        echo "dsh-oc lock resolver: grep failed (rc=$scan_rc)" >&2
        return 2
      fi
      raw_matches=''
    fi
  else
    echo 'dsh-oc lock resolver: neither rg nor grep is available' >&2
    return 2
  fi

  local unique_matches
  unique_matches="$(printf '%s\n' "$raw_matches" | sed 's#.*tar.gz/##' | awk 'NF' | sort -u)"
  local -a commits=()
  if [[ -n "$unique_matches" ]]; then
    mapfile -t commits <<<"$unique_matches"
  fi
  if [[ "${#commits[@]}" == "0" ]]; then
    echo "dsh-oc lock resolver: no dsh-oc codeload commit in $lock" >&2
    return 2
  fi
  if [[ "${#commits[@]}" != "1" ]]; then
    echo "dsh-oc lock resolver: ambiguous dsh-oc codeload commits in $lock: ${commits[*]}" >&2
    return 2
  fi
  printf '%s\n' "${commits[0]}"
}

if [[ "${1:-}" == '--resolve-lock' ]]; then
  if [[ "$#" != "2" ]]; then
    echo 'usage: update-local-install.sh --resolve-lock <pnpm-lock.yaml>' >&2
    exit 2
  fi
  resolve_dsh_oc_commit "$2"
  exit $?
fi

if [[ "${1:-}" == '--assert-resolved' ]]; then
  if [[ "$#" != "3" || ! "${2:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'usage: update-local-install.sh --assert-resolved <40-char-sha> <pnpm-lock.yaml>' >&2
    exit 2
  fi
  resolved_commit="$(resolve_dsh_oc_commit "$3")"
  if [[ "$resolved_commit" != "$2" ]]; then
    echo "dsh-oc lock resolver: expected $2, got $resolved_commit" >&2
    exit 1
  fi
  printf '%s\n' "$resolved_commit"
  exit 0
fi

REF="${1:-develop}"
SPEC="github:chiro2001/dsh-oc#$REF"

echo "== update local dsh profile to $SPEC =="
dsh plugin --profile oc add "$SPEC" >/dev/null

PROFILE_DIR="$HOME/.dsh/profiles/oc"
LOCK="$PROFILE_DIR/pnpm-lock.yaml"
RESOLVED="$(resolve_dsh_oc_commit "$LOCK")"
if [[ "$REF" =~ ^[0-9a-f]{40}$ && "$RESOLVED" != "$REF" ]]; then
  echo "dsh-oc lock resolver: full-SHA ref $REF resolved to $RESOLVED" >&2
  exit 1
fi
echo "  resolved dsh-oc commit: $RESOLVED"

if command -v dsh-oc >/dev/null 2>&1; then
  echo "  dsh-oc --version: $(dsh-oc --version 2>&1 | head -1)"
fi
echo "update-local-install: PASSED"
