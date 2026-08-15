#!/usr/bin/env node
// Regenerate opencode-assets.json from the authenticated GitHub CLI.
// Usage: HTTPS_PROXY=... HTTP_PROXY=... node scripts/update-opencode-assets.mjs [version] [commit]
// The version/commit are read from opencode-version.json unless supplied as args.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const currentVersion = JSON.parse(
  readFileSync(new URL('opencode-version.json', root), 'utf8'),
)
const version = process.argv[2] ?? currentVersion.version
const commit = process.argv[3] ?? currentVersion.commit

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`invalid version: ${version}`)
}
if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
  throw new Error(`invalid commit: ${commit}`)
}

const jq = [
  '[.assets[] | select(.name | test("^opencode-(linux|darwin|windows)-',
  '(x64|arm64)(-baseline)?(-musl)?[.](tar[.]gz|zip)$")) | ',
  '{name, digest, size, browser_download_url}]',
].join('')

const raw = execFileSync(
  'gh',
  ['api', `repos/anomalyco/opencode/releases/tags/v${version}`, '--jq', jq],
  { encoding: 'utf8' },
)

function npmIntegrityFor(name) {
  const rawIntegrity = execFileSync(
    'npm',
    ['view', `${name}@${version}`, 'dist.integrity', '--json'],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(rawIntegrity)
  const integrity = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`no npm sha512 integrity for ${name}@${version}`)
  }
  return integrity
}

const assets = {}
for (const item of JSON.parse(raw)) {
  const key = item.name
    .replace(/^opencode-/, '')
    .replace(/\.(tar\.gz|zip)$/, '')
  const [os, arch, ...variants] = key.split('-')
  const npm = `opencode-${key}`
  assets[key] = {
    platform: {
      os,
      arch,
      baseline: variants.includes('baseline'),
      musl: variants.includes('musl'),
    },
    npm,
    npmIntegrity: npmIntegrityFor(npm),
    url: item.browser_download_url,
    sha256: item.digest.replace(/^sha256:/, ''),
    size: item.size,
  }
}

if (Object.keys(assets).length === 0) {
  throw new Error(`no matching assets found for v${version}`)
}

const manifest = { version, assets }
writeFileSync(
  new URL('opencode-assets.json', root),
  `${JSON.stringify(manifest, null, 2)}\n`,
)

console.log(
  `wrote ${Object.keys(assets).length} opencode assets for v${version}`,
)
