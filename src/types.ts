export interface OcBridgeService {
  readonly url: string
  readonly port: number
}

export interface OpenCodeAsset {
  /** Platform facts derived from the asset key. */
  platform?: {
    os: string
    arch: string
    baseline: boolean
    musl: boolean
  }
  /** Official npm platform package name, e.g. `opencode-linux-x64`. */
  npm?: string
  /** npm registry tarball integrity (sha512), verified by the package manager. */
  npmIntegrity?: string
  url: string
  sha256: string
  size: number
}

export interface OpenCodeAssetsManifest {
  version: string
  assets: Record<string, OpenCodeAsset>
}

export interface OpenCodeVersionManifest {
  version: string
  commit: string
  npm: string
}

export const OPENCODE_BIN_ENV = 'DSH_OC_OPENCODE_BIN'
export const OPENCODE_HOME_DIR = 'opencode'
export const OPENCODE_VERSION_FILE = 'opencode-version.json'
export const OPENCODE_ASSETS_FILE = 'opencode-assets.json'
