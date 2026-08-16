#!/usr/bin/env node
// `dsh-oc` — shortcut for `dsh --profile oc`, forwarding every argument and
// the terminal session to the real dsh CLI. Exit code mirrors dsh.
import { spawnSync } from 'node:child_process'

const args = ['--profile', 'oc', ...process.argv.slice(2)]
const result = spawnSync('dsh', args, { stdio: 'inherit' })

if (result.error) {
  console.error(`dsh-oc: failed to run dsh: ${result.error.message}`)
  console.error('dsh-oc: make sure the dsh CLI is installed and on PATH (npm i -g @deepseek-ai/dsh)')
  process.exit(127)
}

process.exit(result.status ?? 1)
