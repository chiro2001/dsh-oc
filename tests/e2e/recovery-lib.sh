#!/usr/bin/env bash
# Shared helpers for the recovery/fault-domain e2e shell drivers. Sources
# tests/e2e/common.sh first and relies on its E2E_* globals.
set -euo pipefail

# Wait until the real opencode TUI is ready (≤60s).
recovery_wait_tui_ready() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    e2e_tui_capture "$E2E_RUN_DIR/tui-ready.txt"
    if grep -qa 'Ask anything' "$E2E_RUN_DIR/tui-ready.txt" \
      || grep -qa 'ctrl+p commands' "$E2E_RUN_DIR/tui-ready.txt"; then
      return 0
    fi
    if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
      echo "recovery: dsh exited while waiting for TUI: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
      return 1
    fi
    sleep 1
  done
  return 1
}

# Wait until the first user prompt text is visible in the v1 message API.
recovery_wait_text() {
  local url="$1"
  local want="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local text
    text="$(curl -s "$url" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
    if [[ "$text" == *"$want"* ]]; then
      return 0
    fi
    sleep 1
  done
  echo "recovery: reply text not seen for $url (want $want)" >&2
  return 1
}

# Wait until the authoritative idle state (POST /api/session/:id/wait).
recovery_wait_idle() {
  local bridge="$1"
  local sid="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$bridge/api/session/$sid/wait")"
    if [[ "$code" == "204" ]]; then
      return 0
    fi
    if [[ "$code" != "503" ]]; then
      echo "recovery: session wait returned $code" >&2
      return 1
    fi
    sleep 1
  done
  echo "recovery: session did not become idle in time" >&2
  return 1
}

# v2 normalized message graph: per-message parts, user text folded in, tool
# name/status/output included. Used for exactly-once recovery assertions.
recovery_signature_v2() {
  local bridge="$1"
  local sid="$2"
  local out="$3"
  curl -s "$bridge/api/session/$sid/message" | jq -c '
    def norm_part:
      if .type == "tool" then
        { type, name: (.name // ""), status: .state.status,
          text: ((.state.content // []) | map(.text // "") | join("")) }
      else
        { type, text: (.text // "") }
      end;
    [ .data[] as $msg |
      {
        type: $msg.type,
        parts: (if $msg.type == "user" then [{ type: "text", text: ($msg.text // "") }]
                else [$msg.content[]? | norm_part] end)
      }
    ]
  ' > "$out"
}

# v1 normalized graph carries the parent chain the official TUI consumes.
# Parent ids are normalized to relative indexes so warm (surface ids) and
# cold (raw dsh ids) projections are comparable.
recovery_signature_v1() {
  local bridge="$1"
  local sid="$2"
  local out="$3"
  curl -s "$bridge/session/$sid/message" | jq -c '
    def norm_part:
      if .type == "tool" then
        { type, name: (.tool // ""), status: .state.status,
          text: (.state.output // .state.error // "") }
      else
        { type, text: (.text // "") }
      end;
    . as $all |
    [ $all[] as $msg |
      {
        role: $msg.info.role,
        parent: (if $msg.info.parentID == null then null else
          ([ $all | to_entries[] | select(.value.info.id == $msg.info.parentID) | .key ][0] // null) end),
        parts: [$msg.parts[]? | norm_part]
      }
    ]
  ' > "$out"
}

# Sanity guards against empty assertions: at least one completed tool part
# with output is required only when the graph has tool parts; assistant
# parents must always resolve.
recovery_assert_sane() {
  local v1="$1"
  local v2="$2"
  if ! jq -e '
    all(.[]; .role != "assistant" or .parent != null)
  ' "$v1" >/dev/null; then
    echo "recovery: v1 graph has dangling assistant parent" >&2
    cat "$v1" >&2
    return 1
  fi
  if jq -e '[.. | objects | select(.type? == "tool")] | length > 0' "$v2" >/dev/null 2>&1; then
    if ! jq -e '
      ([ .[] | select(.parts[]?.type == "tool")
          | select(.parts[] | (.status == "completed" and (.text | length) > 0)) ] | length) > 0
    ' "$v2" >/dev/null; then
      echo "recovery: no completed tool part with output in v2 graph" >&2
      cat "$v2" >&2
      return 1
    fi
  fi
  return 0
}

recovery_compare_graphs() {
  local label="$1"
  local live="$2"
  local re="$3"
  if ! jq -e -n \
    --slurpfile a "$live" \
    --slurpfile b "$re" '
      ($a[0] | length) == ($b[0] | length)
      and ([$a[0][].type] == [$b[0][].type])
      and ([$a[0][].parent] == [$b[0][].parent])
      and ([$a[0][].parts] == [$b[0][].parts])
    ' >/dev/null; then
    echo "recovery: $label graphs differ" >&2
    echo "--- live ---" >&2
    cat "$live" >&2
    echo "--- reattach ---" >&2
    cat "$re" >&2
    return 1
  fi
  return 0
}

# Assert `prefix` is a prefix of `full` (exactly-once persisted subset).
recovery_assert_prefix() {
  local label="$1"
  local prefix="$2"
  local full="$3"
  if ! jq -e -n \
    --slurpfile p "$prefix" \
    --slurpfile f "$full" '
      ($p[0] | length) <= ($f[0] | length)
      and ($p[0] == $f[0][0:($p[0] | length)])
    ' >/dev/null; then
    echo "recovery: $label is not a prefix of the final graph" >&2
    echo "--- prefix ---" >&2
    cat "$prefix" >&2
    echo "--- full ---" >&2
    cat "$full" >&2
    return 1
  fi
  return 0
}
