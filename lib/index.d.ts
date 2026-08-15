//#region src/types.d.ts
interface OcBridgeService {
  readonly url: string;
  readonly port: number;
  /** Change the bridge working directory (attach `--dir` support). */
  setCwd?(directory: string): void;
  /** Warm one session's tail history (attach `--session` resume support). */
  prefetchSession?(sessionId: string): void;
  /** Whether this run accepted new user input. */
  hasNewActivity?(): boolean;
}
interface OpenCodeAsset {
  /** Platform facts derived from the asset key. */
  platform?: {
    os: string;
    arch: string;
    baseline: boolean;
    musl: boolean;
  };
  /** Official npm platform package name, e.g. `opencode-linux-x64`. */
  npm?: string;
  /** npm registry tarball integrity (sha512), verified by the package manager. */
  npmIntegrity?: string;
  url: string;
  sha256: string;
  size: number;
}
interface OpenCodeAssetsManifest {
  version: string;
  assets: Record<string, OpenCodeAsset>;
}
interface OpenCodeVersionManifest {
  version: string;
  commit: string;
  npm: string;
}
declare const OPENCODE_BIN_ENV = "DSH_OC_OPENCODE_BIN";
declare const OPENCODE_HOME_DIR = "opencode";
declare const OPENCODE_VERSION_FILE = "opencode-version.json";
declare const OPENCODE_ASSETS_FILE = "opencode-assets.json";
//#endregion
//#region src/index.d.ts
/** dsh-oc bundle version (keep in sync with package.json). */
declare const DSH_OC_VERSION = "0.1.0-rc.1";
declare const OPENCODE_VERSION = "1.18.18";
declare const OPENCODE_COMMIT = "4643e65";
//#endregion
export { DSH_OC_VERSION, OPENCODE_ASSETS_FILE, OPENCODE_BIN_ENV, OPENCODE_COMMIT, OPENCODE_HOME_DIR, OPENCODE_VERSION, OPENCODE_VERSION_FILE, OcBridgeService, OpenCodeAsset, OpenCodeAssetsManifest, OpenCodeVersionManifest };
//# sourceMappingURL=index.d.ts.map