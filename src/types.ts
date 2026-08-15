export interface OcBridgeService {
  readonly url: string
  readonly port: number
}

export interface OpenCodeAsset {
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
