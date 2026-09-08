#!/usr/bin/env bash
# Real opencode TUI command e2e: seed history, attach the TUI, type `/preset`
# (first Enter completes the slash candidate, second Enter executes) and see
# the preset result; then invoke the builtin
# `/compact` palette slash and observe a visible status/result (with the mock
# LLM a legal "could not produce a useful summary" error is accepted). Exit
# cleanly afterwards.
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

e2e_new_run "tui-command" "danger-full-access" "success,success,success" "1"

echo "== seed session history through the bridge API =="
E2E_ACTIVE_SESSION="dsh-oc-command-seed-${E2E_RUNID}"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
SEED_URL="$E2E_BRIDGE_URL"

SESSION="$(curl -s -X POST "$SEED_URL/session" -H 'Content-Type: application/json' -d '{}' | jq -er .id)"
echo "  seeded session: $SESSION"
for text in "e2e command seed: first" "e2e command seed: second"; do
  curl -s -X POST "$SEED_URL/session/$SESSION/message" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$text\"}]}" | jq -e '.info.role == "assistant"' >/dev/null
done

local_text=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  local_text="$(curl -s "$SEED_URL/session/$SESSION/message" | jq -r '[.. | objects | select(has("text")) | .text] | join(" ")' 2>/dev/null || true)"
  if [[ "$local_text" == *"mock response recovered"* && "$(grep -o 'mock response recovered' <<<"$local_text" | wc -l)" -ge 2 ]]; then
    break
  fi
  sleep 1
done
if [[ "$local_text" != *"mock response recovered"* ]]; then
  echo "e2e: seeded assistant replies not seen" >&2
  exit 1
fi
echo "  seeded history has two assistant replies"

echo "== restart dsh with the real TUI attached to the session =="
e2e_stop_dsh "$E2E_ACTIVE_SESSION"
E2E_ACTIVE_SESSION=""

e2e_tui_start "--session $SESSION"
e2e_tui_wait_attach
TUI_URL="$E2E_BRIDGE_URL"

SEED_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-command-boot.txt"
  for pattern in "e2e command seed: first" "mock response recovered"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-command-boot.txt"; then
      SEED_HINT="$pattern"
      break 2
    fi
  done
  if [[ -s "$E2E_RUN_DIR/dsh-exit.txt" ]]; then
    echo "e2e: dsh exited while waiting for TUI render: $(cat "$E2E_RUN_DIR/dsh-exit.txt")" >&2
    tmux capture-pane -p -S -200 -t "$E2E_TUI_SESSION" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [[ -z "$SEED_HINT" ]]; then
  echo "e2e: seeded session content not visible in TUI pane" >&2
  exit 1
fi
echo "  seeded content visible: \"$SEED_HINT\""

echo "== /preset autocomplete, Enter + Enter =="
e2e_tui_capture "$E2E_RUN_DIR/tui-before-preset.txt"
USER_COUNT_BEFORE="$(e2e_curl -s "$TUI_URL/session/$SESSION/message" | jq '[.[] | select(.info.role == "user")] | length')"

# OpenCode renders the slash autocomplete asynchronously. Sending both Enter
# keys in one tmux batch can race that render and leave the input on the
# `/preset` candidate instead of opening the preset selector. Wait for the
# actual candidate and require two identical pane captures before selecting
# it; the second wait below is tied to the visible selector state.
tmux send-keys -t "$E2E_TUI_SESSION" -l "/preset"
PRESET_AUTOCOMPLETE_STABLE=""
PRESET_AUTOCOMPLETE_PREV=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-preset-autocomplete.txt"
  if grep -qaE '┃[[:space:]]+/preset[[:space:]]+List or switch the session dsh agent preset' \
    "$E2E_RUN_DIR/tui-preset-autocomplete.txt" \
    && grep -qaE '┃[[:space:]]+/preset[[:space:]]*$' "$E2E_RUN_DIR/tui-preset-autocomplete.txt"; then
    current="$(e2e_tui_frame_fingerprint "$E2E_RUN_DIR/tui-preset-autocomplete.txt")"
    if [[ -n "$PRESET_AUTOCOMPLETE_PREV" && "$current" == "$PRESET_AUTOCOMPLETE_PREV" ]]; then
      PRESET_AUTOCOMPLETE_STABLE="1"
      break
    fi
    PRESET_AUTOCOMPLETE_PREV="$current"
  fi
  sleep 0.2
done
if [[ -z "$PRESET_AUTOCOMPLETE_STABLE" ]]; then
  echo "e2e: /preset autocomplete did not become stable before first Enter" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-preset-autocomplete-failure"
  tail -80 "$E2E_RUN_DIR/tui-preset-autocomplete-failure.scrollback.txt" >&2 || true
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" Enter

# The first Enter selects `/preset`. The TUI keeps the selected command in the
# input while it closes the autocomplete popup; only then is the second Enter
# the submit key. Do not confuse the selected input with the result card (the
# latter is rendered only after the second Enter).
PRESET_SELECTED_STABLE=""
PRESET_SELECTED_PREV=""
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-preset-selected.txt"
  if grep -qaE '┃[[:space:]]+/preset[[:space:]]*$' "$E2E_RUN_DIR/tui-preset-selected.txt" \
    && ! grep -qaE '┃[[:space:]]+/preset[[:space:]]+List or switch the session dsh agent preset' \
      "$E2E_RUN_DIR/tui-preset-selected.txt"; then
    current="$(e2e_tui_frame_fingerprint "$E2E_RUN_DIR/tui-preset-selected.txt")"
    if [[ -n "$PRESET_SELECTED_PREV" && "$current" == "$PRESET_SELECTED_PREV" ]]; then
      PRESET_SELECTED_STABLE="1"
      break
    fi
    PRESET_SELECTED_PREV="$current"
  fi
  sleep 0.2
done
if [[ -z "$PRESET_SELECTED_STABLE" ]]; then
  echo "e2e: selected /preset input did not become stable before second Enter" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-preset-selected-failure"
  tail -80 "$E2E_RUN_DIR/tui-preset-selected-failure.scrollback.txt" >&2 || true
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" Enter

PRESET_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-preset.txt"
  if grep -qa "No switchable dsh agent presets" "$E2E_RUN_DIR/tui-preset.txt"; then
    PRESET_HINT="No switchable dsh agent presets"
    break
  fi
  if grep -qa "(default)" "$E2E_RUN_DIR/tui-preset.txt"; then
    PRESET_HINT="preset list with (default)"
    break
  fi
  for id in minimal standard code cordis; do
    if ! grep -qa "$id" "$E2E_RUN_DIR/tui-before-preset.txt" \
      && grep -qa "$id" "$E2E_RUN_DIR/tui-preset.txt"; then
      PRESET_HINT="preset id $id"
      break 2
    fi
  done
  sleep 1
done
if [[ -z "$PRESET_HINT" ]]; then
  echo "e2e: /preset result not visible in TUI pane after completion + Enter" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-preset-failure"
  tail -80 "$E2E_RUN_DIR/tui-preset-failure.scrollback.txt" >&2 || true
  exit 1
fi
echo "  /preset result visible: $PRESET_HINT"

USER_COUNT_AFTER="$(e2e_curl -s "$TUI_URL/session/$SESSION/message" | jq '[.[] | select(.info.role == "user")] | length')"
if [[ "$USER_COUNT_AFTER" != "$USER_COUNT_BEFORE" ]]; then
  echo "e2e: /preset triggered a model turn (user messages $USER_COUNT_BEFORE -> $USER_COUNT_AFTER)" >&2
  exit 1
fi
echo "  no model turn triggered (user messages: $USER_COUNT_BEFORE -> $USER_COUNT_AFTER)"

echo "== /compact palette slash =="
tmux send-keys -t "$E2E_TUI_SESSION" C-p
sleep 1
tmux send-keys -t "$E2E_TUI_SESSION" "compact" Enter

COMPACT_HINT=""
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-compact.txt"
  for pattern in \
    "Compaction could not produce a useful summary" \
    "Compacted " \
    "No compactable history yet" \
    "Compaction cancelled" \
    "Compaction unavailable" \
    "Compaction did not finish cleanly" \
    "Compaction failed" \
    "Compaction completed" \
    "Compaction is unavailable"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-compact.txt"; then
      COMPACT_HINT="$pattern"
      break 2
    fi
  done
  sleep 1
done
if [[ -z "$COMPACT_HINT" ]]; then
  echo "e2e: /compact outcome not visible in TUI pane" >&2
  tail -60 "$E2E_RUN_DIR/tui-compact.txt" >&2 || true
  exit 1
fi
echo "  /compact outcome visible: $COMPACT_HINT"

echo "== /help slash command =="
tmux send-keys -t "$E2E_TUI_SESSION" -l "/help"

# `/help` follows the same two-stage slash input path. Wait for its candidate
# before the first Enter, then wait until the candidate is gone and the pane is
# stable before submitting the selected command with the second Enter.
HELP_AUTOCOMPLETE_STABLE=""
HELP_AUTOCOMPLETE_PREV=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-help-autocomplete.txt"
  if grep -qaE '┃[[:space:]]+/help[[:space:]]+Show the dsh-oc capability summary' \
    "$E2E_RUN_DIR/tui-help-autocomplete.txt" \
    && grep -qaE '┃[[:space:]]+/help[[:space:]]*$' "$E2E_RUN_DIR/tui-help-autocomplete.txt"; then
    current="$(e2e_tui_frame_fingerprint "$E2E_RUN_DIR/tui-help-autocomplete.txt")"
    if [[ -n "$HELP_AUTOCOMPLETE_PREV" && "$current" == "$HELP_AUTOCOMPLETE_PREV" ]]; then
      HELP_AUTOCOMPLETE_STABLE="1"
      break
    fi
    HELP_AUTOCOMPLETE_PREV="$current"
  fi
  sleep 0.2
done
if [[ -z "$HELP_AUTOCOMPLETE_STABLE" ]]; then
  echo "e2e: /help autocomplete did not become stable before first Enter" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-help-autocomplete-failure"
  tail -80 "$E2E_RUN_DIR/tui-help-autocomplete-failure.scrollback.txt" >&2 || true
  exit 1
fi
# OpenCode 1.18.18 also exposes its own local Help action as `/help`; the
# bridge command is the second candidate. Select the bridge candidate
# explicitly so this e2e verifies dsh-oc's capability summary rather than the
# generic keymap dialog.
HELP_CANDIDATE_COUNT="$(grep -aE '┃[[:space:]]+/help[[:space:]]+' "$E2E_RUN_DIR/tui-help-autocomplete.txt" | wc -l | tr -d ' ')"
if (( HELP_CANDIDATE_COUNT < 2 )); then
  echo "e2e: expected native and dsh-oc /help candidates, saw $HELP_CANDIDATE_COUNT" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-help-candidates-failure"
  tail -80 "$E2E_RUN_DIR/tui-help-candidates-failure.scrollback.txt" >&2 || true
  exit 1
fi
tmux send-keys -t "$E2E_TUI_SESSION" Down
tmux send-keys -t "$E2E_TUI_SESSION" Enter

HELP_SELECTED_STABLE=""
HELP_SELECTED_PREV=""
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-help-selected.txt"
  # A successful first Enter either already rendered the local help result or
  # left a selected `/help` line with the autocomplete popup closed. In the
  # latter case, wait for two identical frames before the second Enter.
  if grep -qaE '核心能力|docs/FEATURES\.md' "$E2E_RUN_DIR/tui-help-selected.txt"; then
    HELP_SELECTED_STABLE="result"
    break
  fi
  if grep -qaE '┃[[:space:]]+/help[[:space:]]*$' "$E2E_RUN_DIR/tui-help-selected.txt" \
    && ! grep -qaE '┃[[:space:]]+/help[[:space:]]+Show the dsh-oc capability summary' \
      "$E2E_RUN_DIR/tui-help-selected.txt"; then
    current="$(e2e_tui_frame_fingerprint "$E2E_RUN_DIR/tui-help-selected.txt")"
    if [[ -n "$HELP_SELECTED_PREV" && "$current" == "$HELP_SELECTED_PREV" ]]; then
      HELP_SELECTED_STABLE="input"
      break
    fi
    HELP_SELECTED_PREV="$current"
  fi
  sleep 0.2
done
if [[ -z "$HELP_SELECTED_STABLE" ]]; then
  echo "e2e: /help selected input did not become stable before second Enter" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-help-selected-failure"
  tail -80 "$E2E_RUN_DIR/tui-help-selected-failure.scrollback.txt" >&2 || true
  exit 1
fi
if [[ "$HELP_SELECTED_STABLE" == "input" ]]; then
  tmux send-keys -t "$E2E_TUI_SESSION" Enter
fi

HELP_HINT=""
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  e2e_tui_capture "$E2E_RUN_DIR/tui-help-in-tui.txt"
  for pattern in "核心能力" "docs/FEATURES.md"; do
    if grep -qa "$pattern" "$E2E_RUN_DIR/tui-help-in-tui.txt"; then
      HELP_HINT="$pattern"
      break 2
    fi
  done
  sleep 1
done
if [[ -z "$HELP_HINT" ]]; then
  echo "e2e: /help result not visible in TUI pane" >&2
  e2e_tui_capture_diagnostic "$E2E_RUN_DIR/tui-help-failure"
  tail -80 "$E2E_RUN_DIR/tui-help-failure.scrollback.txt" >&2 || true
  exit 1
fi
echo "  /help result visible: $HELP_HINT"

echo "== exit through prompt submit =="
e2e_tui_exit
e2e_tui_capture "$E2E_RUN_DIR/tui-command-after.txt"
if ! grep -qaE '➜|❯|\$ ' "$E2E_RUN_DIR/tui-command-after.txt"; then
  echo "e2e: shell prompt not restored after TUI exit" >&2
  exit 1
fi
echo "  shell prompt restored"
e2e_tui_after_checks

tmux kill-session -t "$E2E_TUI_SESSION" 2>/dev/null || true
node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null

echo "e2e-tui-command: PASSED in $((SECONDS - SCRIPT_START))s"
