#!/usr/bin/env bash
# Audit every local dsh session log (default $DSH_HOME/sessions or $1)
# through the bridge translator: fail on unhandled events, translation
# errors, or conflicting message identities (same id, different role).
#
# Usage:
#   bash scripts/audit-local-sessions.sh [sessions-dir]
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION_ROOT="${1:-$HOME/.dsh/sessions}"
if [[ ! -d "$SESSION_ROOT" ]]; then
  echo "audit-local-sessions: directory not found: $SESSION_ROOT" >&2
  exit 2
fi

SPEC="tests/.audit-local-sessions.spec.ts"
trap 'rm -f "$SPEC"' EXIT

cat > "$SPEC" <<EOF
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { InteractionState } from '../src/bridge/state.js'
import { MuxEventTranslator } from '../src/bridge/events.js'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name === 'session.jsonl.zstd') out.push(full)
  }
  return out
}

describe('local sessions audit', () => {
  it('replays every session under $SESSION_ROOT without issues', () => {
    const files = walk('$SESSION_ROOT').sort((a, b) => statSync(b).size - statSync(a).size)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    let totalEvents = 0
    for (const file of files) {
      const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8')
      const lines = raw.trim().split('\\n').filter(Boolean)
      const state = new InteractionState()
      const unhandled: Record<string, number> = {}
      const errors: string[] = []
      const roles = new Map<string, string>()
      const translator = new MuxEventTranslator({
        cwd: '/work', state,
        log: (m) => {
          if (m.includes('unhandled')) {
            const type = /unhandled (?:session )?event ([^\\s]+)/.exec(m)?.[1] ?? m
            unhandled[type] = (unhandled[type] ?? 0) + 1
          } else if (m.includes('error') || m.includes('failed')) errors.push(m)
        },
      })
      for (const line of lines) {
        const event = JSON.parse(line)
        totalEvents++
        try {
          for (const translated of translator.translate({
            rpcId: 'rpc-' + event.seq,
            payload: { type: 'session/event', sessionId: 's1', event },
          })) {
            if (translated.payload.type === 'message.updated') {
              const info = (translated.payload.properties as { info?: { id?: string; role?: string } }).info
              if (info?.id && info.role) {
                const previous = roles.get(info.id)
                if (previous !== undefined && previous !== info.role) {
                  errors.push('message id ' + info.id + ' role conflict: ' + previous + ' vs ' + info.role)
                }
                roles.set(info.id, info.role)
              }
            }
          }
        } catch (error) {
          errors.push('seq ' + event.seq + ' ' + event.type + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      const unhandledCount = Object.values(unhandled).reduce((a, b) => a + b, 0)
      if (errors.length > 0 || unhandledCount > 0) {
        failures.push(file.split('/').slice(-3).join('/') + ': errors=' + errors.length +
          ' unhandled=' + unhandledCount + ' ' + JSON.stringify(unhandled) +
          (errors.length > 0 ? ' first=' + errors[0] : ''))
      }
    }
    console.log('audited ' + files.length + ' sessions, ' + totalEvents + ' events, failures=' + failures.length)
    if (failures.length > 0) {
      console.error(failures.slice(0, 20).join('\\n'))
      throw new Error(failures.length + ' sessions had issues')
    }
    expect(failures).toEqual([])
  }, 180000)
})
EOF

pnpm vitest run "$SPEC" 2>&1 | tail -15
