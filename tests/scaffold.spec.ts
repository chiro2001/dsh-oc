import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, root), 'utf8')

interface TestAsset {
  url: string
  sha256: string
  size: number
  platform: { os: string; arch: string; baseline: boolean; musl: boolean }
  npm: string
  npmIntegrity: string
}

interface TestAssetManifest {
  version: string
  assets: Record<string, TestAsset>
}

const requiredAssetKeys = [
  'linux-x64',
  'linux-x64-baseline',
  'linux-x64-musl',
  'linux-x64-baseline-musl',
  'linux-arm64',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-x64-baseline',
  'darwin-arm64',
  'windows-x64',
  'windows-x64-baseline',
  'windows-arm64',
]

describe('opencode-version.json', () => {
  it('pins the scaffold release', () => {
    const manifest = JSON.parse(read('opencode-version.json'))
    expect(manifest).toMatchObject({
      version: '1.18.18',
      commit: '4643e65',
      npm: 'opencode-ai@1.18.18',
    })
  })
})

describe('opencode-assets.json', () => {
  it('matches the pinned version and covers every required platform', () => {
    const manifest = JSON.parse(
      read('opencode-assets.json'),
    ) as TestAssetManifest
    expect(manifest.version).toBe('1.18.18')
    for (const key of requiredAssetKeys) {
      expect(manifest.assets).toHaveProperty(key)
    }
  })

  it('has valid urls, sha256 digests and sizes', () => {
    const manifest = JSON.parse(
      read('opencode-assets.json'),
    ) as TestAssetManifest
    for (const [key, asset] of Object.entries(manifest.assets)) {
      expect(asset.platform).toBeDefined()
      expect(asset.platform.os).toMatch(/^(linux|darwin|windows)$/)
      expect(asset.platform.arch).toMatch(/^(x64|arm64)$/)
      expect(asset.platform.baseline).toBeTypeOf('boolean')
      expect(asset.platform.musl).toBeTypeOf('boolean')
      expect(asset.npm).toBe(`opencode-${key}`)
      expect(asset.npmIntegrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.size).toBeTypeOf('number')
      expect(Number.isInteger(asset.size)).toBe(true)
      expect(asset.size).toBeGreaterThan(0)
      expect(asset.url).toMatch(
        /^https:\/\/github\.com\/anomalyco\/opencode\/releases\/download\/v1\.18\.18\//,
      )
      expect(`${key}: ${asset.sha256}`).toMatch(/: [0-9a-f]{64}$/)
    }
  })
})

describe('cordis.patch.yml', () => {
  it('contains the disabled title-llm override and the nine bundle plugins in order', () => {
    const yaml = read('cordis.patch.yml')
    const ids = [...yaml.matchAll(/^\s*- id:\s*(\S+)/gm)].map(
      (match) => match[1],
    )
    expect(ids).toEqual([
      'session-title-llm',
      'webserver',
      'agent-presets',
      'subagent-model-selection-settings',
      'workspace',
      'directory-picker',
      'oc-file-uploads',
      'session-controller',
      'oc-bridge',
      'oc-tui',
    ])
  })

  it('wires oc-tui to oc-bridge and oc-bridge to the dsh 0.1.5 host services', () => {
    const yaml = read('cordis.patch.yml')
    expect(yaml).toMatch(/id: oc-bridge[\s\S]*?inject: \[sessionController, agentPresets, goals, sessionSkillCatalog, agents, sessions, sessionProjections\]/)
    expect(yaml).toMatch(/id: oc-tui[\s\S]*?inject: \[ocBridge\]/)
    expect(yaml).toMatch(/id: oc-file-uploads[\s\S]*?name: '@chiro2001\/dsh-oc\/file-uploads'/)
  })
})

describe('package.json', () => {
  it('points dsh.bundle.patch at the cordis patch', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('@chiro2001/dsh-oc')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.exports['./file-uploads']).toBe('./lib/bridge/file-uploads.js')
  })
})

describe('e2e workflow', () => {
  it('uses the dsh host ABI required by this release and can pack an empty failure directory', () => {
    const workflow = read('.github/workflows/e2e.yml')
    expect(workflow).toContain('@deepseek-ai/dsh@0.1.5-rc.2')
    expect(workflow).not.toContain('@deepseek-ai/dsh@0.1.0-rc.6')
    expect(workflow).toMatch(/Pack e2e runs for upload[\s\S]*mkdir -p \.e2e[\s\S]*tar -C \.e2e/)
  })
})

describe('immutable install drill', () => {
  it('checks both the package version and the lockfile full SHA', () => {
    const script = read('scripts/e2e-install-rollback.sh')
    expect(script).toContain('EXPECTED_CANDIDATE_VERSION')
    expect(script).toContain('resolved commit ${resolved_ref:-unknown}, expected $expected_ref')
    expect(script).toContain("rg -o 'tar\\.gz/[0-9a-f]{40}'")
  })
})

describe('question e2e fixture', () => {
  it('reserves a tool-call slot for both standard question turns', () => {
    const script = read('scripts/e2e-tui-permission-ext.sh')
    expect(script).toContain(
      '"tool_call_success,success,tool_call_success,success,success,success" "0"',
    )
  })
})

describe('flake scan process safety', () => {
  it('keeps pre-existing opencode processes observe-only', () => {
    const script = read('scripts/flake-mini-scan.sh')
    expect(script).toContain('observe-only warning')
    expect(script).not.toMatch(/^\s*kill(?:\s+-9)?\b/m)
    expect(script).not.toMatch(/xargs[^\n]*\bkill\b/)
  })

  it('pins crash cleanup to the dsh/attach PIDs discovered from its tmux pane', () => {
    const common = read('tests/e2e/common.sh')
    const crash = read('scripts/e2e-recovery-crash.sh')
    expect(common).toContain('E2E_TUI_DSH_PID="$dsh_pid"')
    expect(common).toContain('$2 == pane && index($0, overlay) > 0')
    expect(crash).toContain('DSH_PID="$E2E_TUI_DSH_PID"')
    expect(crash).toContain('ATTACH_PID="$E2E_TUI_ATTACH_PID"')
    expect(crash).not.toMatch(/ps -eo pid=,args=.*\/dsh --profile\//)
  })
})

describe('src constants', () => {
  it('exports the pinned opencode version and commit', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.OPENCODE_VERSION).toBe('1.18.18')
    expect(mod.OPENCODE_COMMIT).toBe('4643e65')
  })
})
