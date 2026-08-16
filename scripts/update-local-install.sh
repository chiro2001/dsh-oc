#!/usr/bin/env bash
# Update the local dsh profile's dsh-oc install to a GitHub branch/tag and
# verify the resolved commit plus the dsh-oc --version dual output.
#
# Usage: bash scripts/update-local-install.sh [branch|tag]  (default: develop)
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-develop}"
SPEC="github:chiro2001/dsh-oc#$REF"

echo "== update local dsh profile to $SPEC =="
dsh plugin --profile oc add "$SPEC" >/dev/null

PROFILE_DIR="$HOME/.dsh/profiles/oc"
LOCK="$PROFILE_DIR/pnpm-lock.yaml"
if [[ -f "$LOCK" ]]; then
  RESOLVED="$(rg -o 'tar\.gz/[0-9a-f]{40}' "$LOCK" | head -1 | sed 's#tar\.gz/##')"
  echo "  resolved commit: ${RESOLVED:-unknown}"
else
  echo "  resolved commit: unknown (no pnpm-lock.yaml)"
fi

if command -v dsh-oc >/dev/null 2>&1; then
  echo "  dsh-oc --version: $(dsh-oc --version 2>&1 | head -1)"
fi
echo "update-local-install: PASSED"
