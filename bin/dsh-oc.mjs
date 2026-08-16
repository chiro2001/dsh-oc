#!/usr/bin/env node
// `dsh-oc` — shortcut for `dsh --profile oc`, forwarding every argument and
// the terminal session to the real dsh CLI. Exit code mirrors dsh. `--version`
// reports both the dsh-oc package version and the underlying dsh version so
// users are not misled by dsh's own version string.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const rawArgs = process.argv.slice(2)

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  const dsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  if (dsh.error) {
    console.error(`dsh-oc: failed to run dsh: ${dsh.error.message}`)
    console.error('dsh-oc: make sure the dsh CLI is installed and on PATH (npm i -g @deepseek-ai/dsh)')
    process.exit(127)
  }
  const dshVersion = (dsh.stdout || dsh.stderr || '').trim().split('\n')[0] || 'unknown'
  process.stdout.write(`dsh-oc ${pkg.version} (dsh ${dshVersion})\n`)
  process.exit(dsh.status ?? 1)
}

const args = ['--profile', 'oc', ...rawArgs]
const result = spawnSync('dsh', args, { stdio: 'inherit' })

if (result.error) {
  console.error(`dsh-oc: failed to run dsh: ${result.error.message}`)
  console.error('dsh-oc: make sure the dsh CLI is installed and on PATH (npm i -g @deepseek-ai/dsh)')
  process.exit(127)
}

process.exit(result.status ?? 1)
