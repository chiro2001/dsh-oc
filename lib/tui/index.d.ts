import { OcBridgeService, OpenCodeAssetsManifest } from "../index.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { spawnSync } from "node:child_process";
import { z } from "zod";
//#region src/tui/platform.d.ts
/** The resolved platform facts the rest of oc-tui consumes. */
interface PlatformSelection {
  readonly platform: string;
  readonly arch: string;
  readonly musl: boolean;
  readonly avx2: boolean;
  /** Candidate asset keys in official fallback priority order. */
  readonly candidates: readonly string[];
  /** The first (highest-priority) candidate asset key. */
  readonly key: string;
  /** Release archive extension. */
  readonly extension: '.tar.gz' | '.zip';
  /** The executable name inside the archive/cache. */
  readonly executableName: 'opencode' | 'opencode.exe';
}
//#endregion
//#region src/tui/download.d.ts
/** Response subset needed by the downloader; lets tests inject a fake fetch. */
interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** Fetch injection; the default is Node's global fetch with proxy support. */
type FetchLike = (input: string, init?: RequestInit & {
  dispatcher?: unknown;
}) => Promise<FetchLikeResponse>;
/** Injectable filesystem/command operations for tests. */
interface DownloadOpenCodeOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  version?: string;
  platform?: PlatformSelection;
  manifest?: OpenCodeAssetsManifest;
  key?: string;
  fetchImpl?: FetchLike;
  spawnSyncImpl?: typeof spawnSync;
  probe?: (bin: string) => string | undefined;
}
/**
 * Rewrite a GitHub asset URL through `DSH_OC_OPENCODE_MIRROR` when set.
 * @param url - the manifest asset URL.
 * @param env - environment mapping.
 * @returns the URL to request.
 */
declare function resolveAssetUrl(url: string, env?: Record<string, string | undefined>): string;
//#endregion
//#region src/tui/binary.d.ts
/** Where a resolved binary came from. */
type BinarySource = 'env' | 'cache' | 'path' | 'package' | 'download';
/** A successfully resolved binary and its provenance. */
interface ResolvedBinary {
  readonly bin: string;
  readonly source: BinarySource;
}
/** Injectable operations for unit tests. */
interface BinaryResolverDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  version?: string;
  platform?: PlatformSelection;
  assets?: OpenCodeAssetsManifest;
  /** Config-level binary override; takes precedence over the environment. */
  binaryOverride?: string;
  probe?: (bin: string) => string | undefined | Promise<string | undefined>;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  readdir?: (path: string) => readonly {
    name: string;
    isDirectory(): boolean;
  }[];
  packageRoots?: readonly string[];
  runPackagePostinstall?: (packageDir: string) => Promise<void>;
  /** Install a platform package into `targetDir`; tests inject a no-op/fixture. */
  installNpmPackage?: (packageName: string, version: string, targetDir: string) => Promise<boolean>;
  download?: (options: DownloadOpenCodeOptions) => Promise<string>;
}
//#endregion
//#region src/tui/index.d.ts
/** Environment variable that seeds the opencode TUI with timestamps shown. */
declare const DSH_OC_TUI_TIMESTAMPS = "DSH_OC_TUI_TIMESTAMPS";
/** TUI config file name under OPENCODE_CONFIG_DIR. */
declare const OPENCODE_TUI_FILE = "tui.json";
/** Main opencode config file name under OPENCODE_CONFIG_DIR. */
declare const OPENCODE_CONFIG_FILE = "opencode.json";
/** KV state file used by the opencode TUI for per-feature signals. */
declare const OPENCODE_KV_FILE = "kv.json";
/** Branding TUI plugin directory name inside the isolated opencode config. */
declare const OPENCODE_BRANDING_PLUGIN = "dsh-oc-logo";
/**
 * Verified opencode 1.18.18 switches that disable background update checks,
 * remote model catalog fetches and LSP binary downloads. Set before the child
 * process spawns; the values are read from the process environment.
 */
declare const OPENCODE_NETWORK_SAFETY_ENV: Readonly<Record<string, string>>;
/**
 * Whether timestamps should be enabled for the opencode TUI child.
 * Accepts `1`, `true`, `yes` and `on` (case-insensitive).
 */
declare function tuiTimestampsEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Seed the isolated opencode state so `DSH_OC_TUI_TIMESTAMPS=1` takes effect
 * on the next TUI boot.
 *
 * The opencode 1.18.18 TUI stores the timestamps toggle in its KV state file
 * (`$XDG_STATE_HOME/opencode/kv.json`), so this writes that state and also
 * writes a minimal `tui.json` with `session_toggle_timestamps` /
 * `messages_toggle_timestamps` bound to `ctrl+shift+t` for toggling at runtime.
 * Existing config/state values are preserved by merging.
 */
/** Absolute path of the shipped `tui-branding/` plugin package. */
declare function brandingSourceDir(): string;
/**
 * Seed the isolated opencode TUI state:
 * - always copies the dsh-oc branding plugin into the config dir and lists it
 *   in `tui.json` (replacing the OpenCode ASCII logo on the home screen);
 * - when `DSH_OC_TUI_TIMESTAMPS=1`, additionally enables default timestamps
 *   through `kv.json` and `tui.json` keybinds.
 * Existing config/state values are preserved by merging.
 */
declare function prepareOpenCodeTuiState(dshHome: string, env?: NodeJS.ProcessEnv): void;
/**
 * Seed the isolated opencode config with `autoupdate: false`, preserving any
 * existing values. This is the config-level counterpart of
 * `OPENCODE_DISABLE_AUTOUPDATE` and keeps the attach child from downloading or
 * hot-replacing itself even if a future opencode version changes the env flag.
 */
declare function prepareOpenCodeConfig(dshHome: string): void;
/** oc-tui configuration schema; both fields are optional. */
declare const OcTuiConfig: z.ZodDefault<z.ZodObject<{
  binary: z.ZodOptional<z.ZodString>;
  args: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>>;
type OcTuiConfig = z.infer<typeof OcTuiConfig>;
/** `dsh --profile oc --help` output; kept deliberately static for offline use. */
declare function ocHelp(version?: string): string;
/** Whether the raw dsh args request the dsh-oc help screen. */
declare function helpRequested(args: readonly string[]): boolean;
/** Minimal child-process surface used by the spawn helper (test friendly). */
interface TuiChild {
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}
type SpawnTui = (command: string, args: readonly string[], options: {
  cwd: string;
  stdio: 'inherit';
  env: NodeJS.ProcessEnv;
}) => TuiChild;
/** Timer handle exposed by the injectable timer (Node Timeout structurally). */
interface TimerHandle {
  unref?(): unknown;
}
type TimerSetter = (callback: () => void, ms: number) => TimerHandle;
type TimerClearer = (handle: TimerHandle | undefined) => void;
/** Options for {@link startOpenCodeTui}. */
interface StartTuiOptions {
  bin: string;
  bridge: OcBridgeService;
  tuiArgs: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnTui;
  onExit?: (code: number) => void;
  onError?: (error: Error) => void;
  killTimeoutMs?: number;
  setTimeoutImpl?: TimerSetter;
  clearTimeoutImpl?: TimerClearer;
}
/** A running attach child with forwarding and bounded termination helpers. */
interface RunningTui {
  readonly child: TuiChild;
  /** Forward one parent signal to the child. */
  forward(signal: NodeJS.Signals): void;
  /** SIGTERM the child, then SIGKILL after the configured grace period. */
  terminate(): void;
}
/** Spawn `opencode attach` with stdio inherit and signal/termination helpers. */
declare function startOpenCodeTui(options: StartTuiOptions): RunningTui;
/** Listener shape accepted by the injectable process object. */
type SignalListener = () => void;
/** Minimal process surface for signal-forwarding tests. */
interface SignalProcessLike {
  on(event: string, listener: SignalListener): unknown;
  removeListener(event: string, listener: SignalListener): unknown;
}
/**
 * Forward parent SIGINT/SIGTERM to the running child without force-killing.
 * @param processLike - process or fake process.
 * @param getRunning - returns the current running TUI, if any.
 * @param signals - signals to forward.
 * @returns a disposer removing the listeners.
 */
declare function installSignalForwarding(processLike: SignalProcessLike, getRunning: () => RunningTui | undefined, signals?: readonly NodeJS.Signals[]): () => void;
/**
 * Filter dsh app arguments into opencode `attach` arguments.
 * Unknown/malformed arguments are reported, never silently dropped.
 */
declare function filterSupportedArgs(args: readonly string[]): {
  pass: string[];
  ignored: string[];
};
/**
 * Build the child environment: inherit the parent and isolate opencode state
 * under `$DSH_HOME/opencode`. `OPENCODE_CONFIG_CONTENT` is intentionally
 * never introduced.
 */
declare function buildChildEnv(env?: NodeJS.ProcessEnv, dshHome?: string): NodeJS.ProcessEnv;
/**
 * Request a bounded process exit through `ctx.appExit` when available.
 * @param ctx - context with an optional `appExit`.
 * @param code - desired exit code.
 * @param fallback - exit-code setter used when no `appExit` exists.
 * @returns true when `ctx.appExit` handled the request.
 */
declare function requestExit(ctx: Pick<Context, 'get'>, code: number, fallback?: (code: number) => void): boolean;
/** Input accepted by {@link resolveOpenCodeBinary}. */
type ResolveBinaryInput = BinaryResolverDeps & {
  config?: {
    binary?: string;
  };
};
/**
 * Test/debug helper resolving the binary without spawning the TUI.
 * Accepts either resolver deps or a context-like object carrying `config.binary`.
 */
declare function resolveOpenCodeBinary(input?: ResolveBinaryInput): Promise<ResolvedBinary>;
/**
 * The oc-tui Cordis service. Mounts after `ocBridge` and owns the child's
 * lifetime, signal forwarding, and exit handoff.
 */
declare class OcTuiService extends Service {
  config: OcTuiConfig;
  static inject: string[];
  static Config: z.ZodDefault<z.ZodObject<{
    binary: z.ZodOptional<z.ZodString>;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strip>>;
  private running;
  private readonly removeSignalForwarding;
  constructor(ctx: Context, config: OcTuiConfig);
  protected [Service.init](): Promise<void>;
  private fail;
}
//#endregion
export { type BinaryResolverDeps, type BinarySource, DSH_OC_TUI_TIMESTAMPS, OPENCODE_BRANDING_PLUGIN, OPENCODE_CONFIG_FILE, OPENCODE_KV_FILE, OPENCODE_NETWORK_SAFETY_ENV, OPENCODE_TUI_FILE, OcTuiConfig, OcTuiService, OcTuiService as default, ResolveBinaryInput, type ResolvedBinary, RunningTui, SignalListener, SignalProcessLike, SpawnTui, StartTuiOptions, TimerClearer, TimerHandle, TimerSetter, TuiChild, brandingSourceDir, buildChildEnv, filterSupportedArgs, helpRequested, installSignalForwarding, ocHelp, prepareOpenCodeConfig, prepareOpenCodeTuiState, requestExit, resolveAssetUrl, resolveOpenCodeBinary, startOpenCodeTui, tuiTimestampsEnabled };
//# sourceMappingURL=index.d.ts.map