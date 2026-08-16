#!/usr/bin/env bash
# Replay one real dsh session log through the bridge translator and fail on
# unhandled events or translation errors. Useful after upgrading the bridge
# or investigating a real-session rendering problem.
#
# Usage:
#   bash scripts/replay-session-audit.sh <session.jsonl[.zstd]>
#
# The session file is not committed (it can contain real paths/commands); the
# script generates a temporary vitest spec under tests/ and removes it on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo "usage: replay-session-audit.sh <session.jsonl[.zstd]>" >&2
  exit 2
fi
SESSION_FILE="$(realpath "$1")"
if [[ ! -f "$SESSION_FILE" ]]; then
  echo "replay-session-audit: file not found: $SESSION_FILE" >&2
  exit 2
fi

SPEC="tests/.replay-audit.spec.ts"
trap 'rm -f "$SPEC"' EXIT

cat > "$SPEC" <<EOF
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { InteractionState } from '../src/bridge/state.js'
import { MuxEventTranslator } from '../src/bridge/events.js'

describe('real session replay audit', () => {
  it('translates $SESSION_FILE without unhandled events or errors', () => {
    const raw = '$SESSION_FILE'.endsWith('.zstd')
      ? execFileSync('zstd', ['-dc', '$SESSION_FILE'], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8')
      : execFileSync('cat', ['$SESSION_FILE'], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8')
    const lines = raw.trim().split('\\n').filter(Boolean)
    const state = new InteractionState()
    const unhandled: Record<string, number> = {}
    const errors: string[] = []
    const types: Record<string, number> = {}
    const translator = new MuxEventTranslator({
      cwd: '/work',
      state,
      log: (m) => {
        if (m.includes('unhandled')) {
          const type = /unhandled (?:session )?event ([^\\s]+)/.exec(m)?.[1] ?? m
          unhandled[type] = (unhandled[type] ?? 0) + 1
        } else if (m.includes('error') || m.includes('failed')) {
          errors.push(m)
        }
      },
    })
    for (const line of lines) {
      const event = JSON.parse(line)
      try {
        translator.translate({ rpcId: 'rpc-' + event.seq, payload: { type: 'session/event', sessionId: 's1', event } })
          .forEach((e) => { types[e.payload.type] = (types[e.payload.type] ?? 0) + 1 })
      } catch (error) {
        errors.push('seq ' + event.seq + ' ' + event.type + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (errors.length > 0) console.error('translation errors:', errors.slice(0, 20))
    if (Object.keys(unhandled).length > 0) console.error('unhandled events:', unhandled)
    expect(errors).toEqual([])
    expect(unhandled).toEqual({})
    console.log('replayed ' + lines.length + ' events; translated types:',
      Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 25)))
  })
})
EOF

pnpm vitest run "$SPEC" 2>&1 | tail -25
