#!/usr/bin/env node
// OpenCode protocol compatibility probe.
//
// Compares the route surface the opencode TUI is known to request
// (tests/fixtures/opencode/routes.json, sourced from docs/PROTOCOL.md) against
// the routes actually registered by the oc-bridge, verifies the pinned
// opencode binary version and the installed SDK version, and writes a
// JSON/text compatibility report.
//
// Usage:
//   node scripts/probe-opencode.mjs [--version 1.18.18] [--bin /path/opencode]
//                                   [--routes tests/fixtures/opencode/routes.json]
//                                   [--out .e2e/protocol-probe.json] [--json-only]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function option(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function parseVersion(output) {
  const match = /\b(?:v)?(\d+)\.(\d+)\.(\d+)\b/.exec(String(output ?? ''))
  return match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`
}

function normalizePath(path) {
  return path.replace(/:[^/]+/g, ':p')
}

function routeKey(method, path, kind) {
  return `${method} ${normalizePath(path)} ${kind}`
}

function parseRegisteredRoutes() {
  const routesDir = join(root, 'src', 'bridge', 'routes')
  const routeFiles = [
    'src/bridge/router.ts',
    'src/bridge/routes.ts',
    ...(existsSync(routesDir) ? readdirSync(routesDir).map((file) => `src/bridge/routes/${file}`) : []),
  ]
  const stubs = readFileSync(join(root, 'src', 'bridge', 'stubs.ts'), 'utf8')
  const routes = new Set()
  for (const file of routeFiles) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const match of source.matchAll(/register\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      routes.add(routeKey(match[1], match[2], match[3]))
    }
    for (const match of source.matchAll(/for \(const bare of \[([^\]]*)\]\)/g)) {
      for (const path of match[1].matchAll(/'([^']+)'/g)) {
        routes.add(routeKey('GET', path[1], 'json'))
      }
    }
  }
  for (const match of stubs.matchAll(/jsonRoute\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    routes.add(routeKey(match[1], match[2], 'json'))
  }
  return routes
}

async function resolveBinary(bin) {
  if (bin !== undefined) return bin
  const { resolveOpenCodeBinary } = await import('../lib/tui/index.js')
  const resolved = await resolveOpenCodeBinary({})
  return resolved.bin
}

async function main(argv) {
  const expectedVersion = option(argv, '--version') ?? JSON.parse(
    readFileSync(join(root, 'opencode-version.json'), 'utf8'),
  ).version
  const bin = await resolveBinary(option(argv, '--bin'))
  const fixturePath = option(argv, '--routes') ?? join(root, 'tests', 'fixtures', 'opencode', 'routes.json')
  const outPath = option(argv, '--out')
  const jsonOnly = argv.includes('--json-only')

  const issues = []
  const notes = []

  const versionResult = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
  const actualVersion = parseVersion(versionResult.stdout)
  if (actualVersion !== expectedVersion) {
    issues.push({
      category: 'binary-version',
      message: `opencode binary ${bin} reports ${actualVersion ?? 'unknown'}, expected ${expectedVersion}`,
      fix: `Clear $DSH_HOME/opencode/bin or set DSH_OC_OPENCODE_BIN to a ${expectedVersion} binary.`,
    })
  } else {
    notes.push(`opencode binary ${bin} matches ${expectedVersion}`)
  }

  let sdkVersion
  const sdkPackage = join(root, 'node_modules', '@opencode-ai', 'sdk', 'package.json')
  if (existsSync(sdkPackage)) {
    sdkVersion = JSON.parse(readFileSync(sdkPackage, 'utf8')).version
    if (sdkVersion !== expectedVersion) {
      issues.push({
        category: 'sdk-version',
        message: `installed @opencode-ai/sdk is ${sdkVersion}, expected ${expectedVersion}`,
        fix: 'Run pnpm install with the pinned @opencode-ai/sdk@<expected> before probing.',
      })
    } else {
      notes.push(`@opencode-ai/sdk matches ${expectedVersion}`)
    }
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const registered = parseRegisteredRoutes()
  const expected = new Map()
  for (const route of fixture.routes) {
    expected.set(routeKey(route.method, route.path, route.kind), route)
  }

  for (const [key, route] of expected) {
    if (!registered.has(key)) {
      const normalized = normalizePath(route.path)
      issues.push({
        category: 'missing-route',
        message: `${route.method} ${normalized} (${route.kind}) is requested by the TUI but not registered`,
        fix: `Register ${route.method} '${normalized}' as '${route.kind}' in src/bridge/router.ts ` +
          `(or add a schema-valid jsonRoute in src/bridge/stubs.ts).`,
      })
    }
  }

  const extras = [...registered].filter((key) => !expected.has(key))
  if (extras.length > 0) {
    notes.push(`bridge registers ${extras.length} additional route(s) beyond the fixture (not an error)`)
  }

  const report = {
    tool: 'dsh-oc protocol probe',
    expectedVersion,
    actualBinaryVersion: actualVersion,
    sdkVersion,
    fixture: fixturePath,
    registeredRoutes: registered.size,
    expectedRoutes: expected.size,
    issues,
    notes,
    passed: issues.length === 0,
  }

  if (outPath !== undefined) {
    const target = resolve(root, outPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  }

  if (!jsonOnly) {
    console.log(`probe-opencode: expected ${expectedVersion}, binary ${actualVersion ?? 'unknown'}, SDK ${sdkVersion ?? 'missing'}`)
    for (const note of notes) console.log(`  note: ${note}`)
    for (const issue of issues) {
      console.log(`  FAIL ${issue.category}: ${issue.message}`)
      console.log(`       fix: ${issue.fix}`)
    }
    console.log(`probe-opencode: ${report.passed ? 'PASSED' : 'FAILED'} ` +
      `(${expected.size - issues.filter((i) => i.category === 'missing-route').length}/${expected.size} routes, ${issues.length} issues)`)
  }

  process.exit(report.passed ? 0 : 1)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`probe-opencode: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
})
