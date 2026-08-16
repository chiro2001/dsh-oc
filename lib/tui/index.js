import { OPENCODE_BIN_ENV, OPENCODE_VERSION } from "../index.js";
import { n as ocHelp, t as helpRequested } from "../help-C-3FRWbU.js";
import { Service } from "@deepseek-ai/cordis";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { z } from "zod";
//#region tui-branding/art.ts
/** "DSH" rendered in figlet Slant. */
const DSH = [
	"    ____  _____ __  __",
	"   / __ \\/ ___// / / /",
	"  / / / /\\__ \\/ /_/ / ",
	" / /_/ /___/ / __  /  ",
	"/_____//____/_/ /_/   "
];
/** "OC" rendered in figlet Slant. */
const OC = [
	"   ____  ______",
	"  / __ \\/ ____/",
	" / / / / /     ",
	"/ /_/ / /___   ",
	"\\____/\\____/   "
];
//#endregion
//#region src/tui/brand.ts
const GAP = "   ";
const SUBTITLE = "DeepSeek Harness × OpenCode TUI";
/**
* Plain-text DSH OC brand banner for `--mini` launches. The official mini
* interface does not load TUI plugins (its entry splash is hard-coded), so
* dsh-oc prints the brand itself before spawning the child.
*/
function renderMiniBrand() {
	return `${DSH.map((line, index) => `${line}${GAP}${OC[index] ?? ""}`).join("\n")}\n${SUBTITLE}\n`;
}
//#endregion
//#region src/tui/platform.ts
/**
* Platform/asset selection for the official opencode release binaries.
*
* This mirrors the platform-selection semantics of the official
* `opencode-ai` postinstall script: the same platform/arch mapping, the same
* musl and AVX2 probes, and the same candidate ordering. The returned keys
* are `opencode-assets.json` keys (without the `opencode-` prefix used by the
* npm platform packages).
*/
const PLATFORM_MAP = {
	darwin: "darwin",
	linux: "linux",
	win32: "windows"
};
const ARCH_MAP = {
	x64: "x64",
	arm64: "arm64",
	arm: "arm"
};
const AVX2_CPUINFO = /(^|\s)avx2(\s|$)/i;
const WINDOWS_AVX2_COMMAND = "(Add-Type -MemberDefinition \"[DllImport(\"\"kernel32.dll\"\")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);\" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)";
const WINDOWS_EXECUTABLES = [
	"powershell.exe",
	"pwsh.exe",
	"pwsh",
	"powershell"
];
function defaultReadFile(path) {
	return readFileSync(path, "utf8");
}
function defaultExists(path) {
	return existsSync(path);
}
function defaultExecFileSync(file, args, options = {}) {
	return spawnSync(file, args, {
		encoding: "utf8",
		timeout: 1500,
		windowsHide: true,
		...options
	});
}
/**
* Resolve the platform selection with injectable probes.
* @param deps - optional probe overrides; defaults read the real host.
* @returns the selected asset key and platform facts.
*/
function resolvePlatform(deps = {}) {
	const rawPlatform = deps.platform ?? process.platform;
	const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;
	const arch = ARCH_MAP[deps.arch ?? process.arch] ?? deps.arch ?? process.arch;
	const readFile = deps.readFile ?? defaultReadFile;
	const exists = deps.exists ?? defaultExists;
	const execFileSync = deps.execFileSync ?? defaultExecFileSync;
	const avx2 = supportsAvx2(platform, arch, readFile, execFileSync);
	const musl = isMusl(platform, exists, execFileSync);
	const candidates = candidateKeys(platform, arch, musl, avx2);
	return {
		platform,
		arch,
		musl,
		avx2,
		candidates,
		key: candidates[0] ?? "",
		extension: platform === "linux" ? ".tar.gz" : ".zip",
		executableName: rawPlatform === "win32" ? "opencode.exe" : "opencode"
	};
}
function supportsAvx2(platform, arch, readFile, execFileSync) {
	if (arch !== "x64") return false;
	if (platform === "linux") try {
		return AVX2_CPUINFO.test(readFile("/proc/cpuinfo"));
	} catch {
		return false;
	}
	if (platform === "darwin") try {
		const result = execFileSync("sysctl", ["-n", "hw.optional.avx2_0"], {
			encoding: "utf8",
			timeout: 1500
		});
		if (result.status !== 0) return false;
		return String(result.stdout ?? "").trim() === "1";
	} catch {
		return false;
	}
	if (platform === "windows") for (const executable of WINDOWS_EXECUTABLES) try {
		const result = execFileSync(executable, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			WINDOWS_AVX2_COMMAND
		], {
			encoding: "utf8",
			timeout: 3e3,
			windowsHide: true
		});
		if (result.status !== 0) continue;
		const output = String(result.stdout ?? "").trim().toLowerCase();
		if (output === "true" || output === "1") return true;
		if (output === "false" || output === "0") return false;
	} catch {
		continue;
	}
	return false;
}
function isMusl(platform, exists, execFileSync) {
	if (platform !== "linux") return false;
	try {
		if (exists("/etc/alpine-release")) return true;
	} catch {}
	try {
		const result = execFileSync("ldd", ["--version"], { encoding: "utf8" });
		return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.toLowerCase().includes("musl");
	} catch {
		return false;
	}
}
function candidateKeys(platform, arch, musl, avx2) {
	const base = `${platform}-${arch}`;
	const baseline = arch === "x64" && !avx2;
	if (platform === "linux") {
		if (musl) {
			if (arch === "x64") return baseline ? [
				`${base}-baseline-musl`,
				`${base}-musl`,
				`${base}-baseline`,
				base
			] : [
				`${base}-musl`,
				`${base}-baseline-musl`,
				base,
				`${base}-baseline`
			];
			return [`${base}-musl`, base];
		}
		if (arch === "x64") return baseline ? [
			`${base}-baseline`,
			base,
			`${base}-baseline-musl`,
			`${base}-musl`
		] : [
			base,
			`${base}-baseline`,
			`${base}-musl`,
			`${base}-baseline-musl`
		];
		return [base, `${base}-musl`];
	}
	if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
	return [base];
}
//#endregion
//#region src/tui/download.ts
/**
* Lazy GitHub Release download for the official opencode binary: fetch,
* sha256 verification with one retry, extraction, executable mode, version
* verification and an atomic rename into the dsh opencode cache.
*/
const GITHUB_PREFIX = "https://github.com/";
const MIRROR_ENV = "DSH_OC_OPENCODE_MIRROR";
const MANIFEST_URL = new URL("../../opencode-assets.json", import.meta.url);
/** A download whose integrity check failed; this is the retryable failure. */
var IntegrityError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "IntegrityError";
	}
};
/**
* Rewrite a GitHub asset URL through `DSH_OC_OPENCODE_MIRROR` when set.
* @param url - the manifest asset URL.
* @param env - environment mapping.
* @returns the URL to request.
*/
function resolveAssetUrl(url, env = process.env) {
	const mirror = env[MIRROR_ENV];
	if (mirror === void 0 || mirror.trim().length === 0 || !url.startsWith(GITHUB_PREFIX)) return url;
	return `${mirror.replace(/\/+$/, "")}/${url.slice(19)}`;
}
/**
* Download, verify and cache the opencode binary.
* @param options - overrides for tests and non-default homes.
* @returns the absolute path of the cached executable.
*/
async function downloadOpenCode(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? resolveDshHome(void 0, env);
	const version = options.version ?? "1.18.18";
	const platform = options.platform ?? resolvePlatform();
	const manifest = options.manifest ?? readAssetsManifest();
	const key = options.key ?? platform.key;
	const asset = manifest.assets[key];
	if (asset === void 0) throw new Error(`opencode ${version}: no release asset for ${JSON.stringify(key)} (available: ${Object.keys(manifest.assets).join(", ")})`);
	const target = join(home, "opencode", "bin", version, platform.executableName);
	if (existsSync(target)) try {
		verifyVersion(target, version, options.probe);
		return target;
	} catch {}
	const tmpBase = join(home, "opencode", "tmp");
	const archivePath = join(tmpBase, randomUUID());
	let lastError;
	try {
		for (let attempt = 0; attempt < 2; attempt++) try {
			const url = resolveAssetUrl(asset.url, env);
			const buffer = await fetchBuffer(url, options.fetchImpl);
			const digest = createHash("sha256").update(buffer).digest("hex");
			if (digest !== asset.sha256 || buffer.length !== asset.size) throw new IntegrityError(`sha256 mismatch for ${url}: expected ${asset.sha256} (${asset.size} bytes), got ${digest} (${buffer.length} bytes)`);
			mkdirSync(tmpBase, { recursive: true });
			writeFileSync(archivePath, buffer);
			const extracted = findExecutable(extractArchive(archivePath, platform, options.spawnSyncImpl), platform.executableName);
			if (extracted === void 0) throw new Error(`archive did not contain ${platform.executableName}`);
			chmodSync(extracted, 493);
			verifyVersion(extracted, version, options.probe);
			mkdirSync(dirname(target), { recursive: true });
			if (existsSync(target)) rmSync(target, { force: true });
			renameSync(extracted, target);
			return target;
		} catch (error) {
			lastError = error;
			rmSync(tmpBase, {
				recursive: true,
				force: true
			});
			if (attempt === 0 && error instanceof IntegrityError) continue;
			break;
		}
	} finally {
		rmSync(tmpBase, {
			recursive: true,
			force: true
		});
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Failed to download opencode ${version} (asset ${key}): ${message}\nYou can recover by:\n  - setting ${OPENCODE_BIN_ENV} to an absolute path of a working opencode binary,\n  - running: dsh plugin --profile oc add opencode-ai@1.18.18\n  - or manually downloading ${asset.url} and placing the executable at ${target}`);
}
function readAssetsManifest() {
	return JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
}
async function fetchBuffer(url, fetchImpl) {
	const response = await (fetchImpl ?? defaultFetch)(url, {});
	if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
	return Buffer.from(await response.arrayBuffer());
}
async function defaultFetch(input, init) {
	try {
		const { EnvHttpProxyAgent } = await import("node:undici");
		if (typeof EnvHttpProxyAgent === "function") {
			const options = {
				...init,
				dispatcher: new EnvHttpProxyAgent()
			};
			return await fetch(input, options);
		}
	} catch {}
	return await fetch(input, init);
}
function extractArchive(archivePath, platform, spawnImpl = spawnSync) {
	const extractDir = `${archivePath}-x`;
	mkdirSync(extractDir, { recursive: true });
	let result;
	if (platform.extension === ".zip") {
		if (platform.platform === "win32") result = spawnImpl("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`
		], {
			stdio: "pipe",
			windowsHide: true
		});
		else result = spawnImpl("unzip", [
			"-q",
			archivePath,
			"-d",
			extractDir
		], {
			stdio: "pipe",
			windowsHide: true
		});
	} else result = spawnImpl("tar", [
		"-xzf",
		archivePath,
		"-C",
		extractDir
	], {
		stdio: "pipe",
		windowsHide: true
	});
	if (result.error !== void 0) throw result.error;
	if (result.status !== 0) throw new Error(`archive extraction failed (${platform.extension}): ${String(result.stderr ?? "")}`);
	return extractDir;
}
function findExecutable(root, name) {
	const entries = readdirSync(root, { recursive: true });
	for (const entry of entries) {
		const full = join(root, entry);
		if (basename(full) === name) try {
			if (statSync(full).isFile()) return resolve(full);
		} catch {}
	}
}
function verifyVersion(bin, version, probe) {
	const probeImpl = probe ?? defaultProbe$1;
	let output;
	try {
		output = probeImpl(bin);
	} catch {
		output = void 0;
	}
	if (output === void 0 || !output.includes(version)) throw new Error(`extracted binary at ${bin} did not report opencode ${version} (got ${JSON.stringify(output)})`);
}
function defaultProbe$1(bin) {
	try {
		const result = spawnSync(bin, ["--version"], {
			encoding: "utf8",
			timeout: 5e3,
			windowsHide: true
		});
		if (result.error !== void 0 || result.status !== 0) return void 0;
		return String(result.stdout ?? "");
	} catch {
		return;
	}
}
//#endregion
//#region src/tui/binary.ts
/**
* opencode binary resolver for oc-tui.
*
* Priority:
* 1. `DSH_OC_OPENCODE_BIN` (absolute path only)
* 2. `$DSH_HOME/opencode/bin/<version>/opencode(.exe)`
* 3. `opencode` on `PATH`
* 4. official npm platform package (`opencode-<platform>-<arch>[-baseline][-musl]`)
*    lazily installed under `$DSH_HOME/opencode/packages/<platform-key>`
* 5. an installed `opencode-ai` package (its official postinstall is run first)
* 6. lazy GitHub Release download (per-platform `sha256` from the manifest)
*/
/**
* Extract the first `x.y.z` semver from an opencode `--version` probe.
* Accepts `1.18.18`, `opencode 1.18.18` and `v1.18.18` outputs.
*/
function parseOpenCodeVersion(output) {
	if (output === void 0) return void 0;
	const match = /\b(?:v)?(\d+)\.(\d+)\.(\d+)\b/.exec(output);
	if (match === null) return void 0;
	return `${match[1]}.${match[2]}.${match[3]}`;
}
/**
* Probe a binary and verify its `--version` matches the expected opencode
* version. Throws with a clear remediation message on mismatch.
*/
async function verifyOpenCodeVersion(bin, expected = OPENCODE_VERSION, probe = defaultProbe) {
	const output = await probe(bin);
	const actual = parseOpenCodeVersion(output);
	if (actual !== expected) throw new Error(`opencode binary ${JSON.stringify(bin)} reports version ${actual ?? "unknown"} (${JSON.stringify(output ?? "")}), expected ${expected}. Clear the versioned cache under $DSH_HOME/opencode/bin or set ${OPENCODE_BIN_ENV} to a binary matching ${expected}.`);
	return actual;
}
/**
* Resolve the opencode binary with the documented priority.
* @param deps - overrides for tests and non-default environments.
* @returns the selected executable and its source.
*/
async function resolveOpenCodeBinary$1(deps = {}) {
	const env = deps.env ?? process.env;
	const home = deps.home ?? resolveDshHome(void 0, env);
	const version = deps.version ?? "1.18.18";
	const platform = deps.platform ?? resolvePlatform();
	const exists = deps.exists ?? existsSync;
	const probe = deps.probe ?? defaultProbe;
	const matches = async (bin) => {
		try {
			return parseOpenCodeVersion(await probe(bin)) === version;
		} catch {
			return false;
		}
	};
	const override = deps.binaryOverride ?? env["DSH_OC_OPENCODE_BIN"];
	if (override !== void 0) {
		if (!isAbsolute(override)) throw new Error(`${OPENCODE_BIN_ENV} must be an absolute path, got ${JSON.stringify(override)}`);
		if (!exists(override)) throw new Error(`${OPENCODE_BIN_ENV} points to a missing binary: ${JSON.stringify(override)}`);
		if (await matches(override)) return {
			bin: override,
			source: "env"
		};
		await verifyOpenCodeVersion(override, version, probe);
	}
	const cacheBin = join(home, "opencode", "bin", version, platform.executableName);
	if (exists(cacheBin) && await matches(cacheBin)) return {
		bin: cacheBin,
		source: "cache"
	};
	for (const dir of pathEntries(env.PATH ?? "")) {
		const candidate = join(dir, platform.executableName);
		if (exists(candidate) && await matches(candidate)) return {
			bin: candidate,
			source: "path"
		};
	}
	for (const key of platform.candidates) {
		const packageName = npmPackageNameFor(key);
		const targetDir = npmPackageTargetDir(home, key);
		const packageBin = npmPackageBinaryPath(targetDir, packageName, platform);
		if (exists(packageBin) && await matches(packageBin)) return {
			bin: packageBin,
			source: "package"
		};
		const install = deps.installNpmPackage ?? installNpmPackage;
		try {
			if (await install(packageName, version, targetDir) && exists(packageBin) && await matches(packageBin)) return {
				bin: packageBin,
				source: "package"
			};
		} catch {}
	}
	for (const packageDir of findPackageDirs(home, deps)) {
		if (!exists(join(packageDir, "package.json"))) continue;
		const runPostinstall = deps.runPackagePostinstall ?? runOfficialPostinstall;
		try {
			await runPostinstall(packageDir);
		} catch {}
		const binaryPath = packageBinaryPath(packageDir, platform, exists, deps.readFile);
		if (binaryPath === void 0) continue;
		if (await matches(binaryPath)) return {
			bin: binaryPath,
			source: "package"
		};
	}
	return {
		bin: await (deps.download ?? downloadOpenCode)({
			env,
			home,
			version,
			platform,
			manifest: deps.assets
		}),
		source: "download"
	};
}
/** Official npm platform package name for a manifest asset key. */
function npmPackageNameFor(key) {
	return `opencode-${key}`;
}
/** Cache directory for an installed npm platform package. */
function npmPackageTargetDir(home, key) {
	return join(home, "opencode", "packages", key);
}
/** Binary path inside an npm platform package installed with `npm --prefix`. */
function npmPackageBinaryPath(targetDir, packageName, platform) {
	return join(targetDir, "node_modules", packageName, "bin", platform.executableName);
}
async function installNpmPackage(packageName, version, targetDir) {
	const spec = `${packageName}@${version}`;
	const npmResult = spawnSync("npm", [
		"install",
		"--ignore-scripts",
		"--no-save",
		"--no-audit",
		"--no-fund",
		"--loglevel=error",
		"--prefix",
		targetDir,
		spec
	], {
		encoding: "utf8",
		timeout: 12e4,
		windowsHide: true,
		stdio: "ignore"
	});
	if (npmResult.error === void 0 && npmResult.status === 0) return true;
	const pnpmResult = spawnSync("pnpm", [
		"install",
		"--ignore-scripts",
		"--no-save",
		"--dir",
		targetDir,
		spec
	], {
		encoding: "utf8",
		timeout: 12e4,
		windowsHide: true,
		stdio: "ignore"
	});
	return pnpmResult.error === void 0 && pnpmResult.status === 0;
}
function defaultProbe(bin) {
	try {
		const result = spawnSync(bin, ["--version"], {
			encoding: "utf8",
			timeout: 5e3,
			windowsHide: true
		});
		if (result.error !== void 0 || result.status !== 0) return void 0;
		return String(result.stdout ?? "");
	} catch {
		return;
	}
}
function pathEntries(pathValue) {
	return pathValue.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function findPackageDirs(home, deps) {
	const dirs = [...deps.packageRoots ?? []];
	const profilesDir = join(home, "profiles");
	dirs.push(join(profilesDir, "node_modules", "opencode-ai"));
	try {
		for (const entry of deps.readdir?.(profilesDir) ?? readdirSync(profilesDir, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(profilesDir, entry.name, "node_modules", "opencode-ai"));
	} catch {}
	dirs.push(join(home, "node_modules", "opencode-ai"));
	const seen = /* @__PURE__ */ new Set();
	return dirs.filter((dir) => {
		const normalized = resolve(dir);
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return (deps.exists ?? existsSync)(normalized);
	});
}
function packageBinaryPath(packageDir, platform, exists, readFile) {
	let manifest;
	try {
		manifest = JSON.parse((readFile ?? ((path) => readFileSync(path, "utf8")))(join(packageDir, "package.json")));
	} catch {
		return;
	}
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[platform.executableName] ?? manifest.bin?.opencode;
	return [
		bin !== void 0 ? join(packageDir, bin) : void 0,
		join(packageDir, "bin", platform.executableName),
		join(packageDir, "bin", "opencode.exe")
	].filter((candidate) => candidate !== void 0).find((candidate) => exists(candidate));
}
async function runOfficialPostinstall(packageDir) {
	const result = spawnSync("node", ["postinstall.mjs"], {
		cwd: packageDir,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error !== void 0) throw result.error;
	if (result.status !== 0) throw new Error(`opencode-ai postinstall failed with exit code ${String(result.status)}`);
}
//#endregion
//#region src/tui/index.ts
/**
* oc-tui Cordis plugin: resolve the opencode binary, spawn
* `opencode attach <bridge-url>` with an isolated data home, forward parent
* signals, and request a bounded dsh exit when the child exits.
*/
/** Environment variable that seeds the opencode TUI with timestamps shown. */
const DSH_OC_TUI_TIMESTAMPS = "DSH_OC_TUI_TIMESTAMPS";
/** TUI config file name under OPENCODE_CONFIG_DIR. */
const OPENCODE_TUI_FILE = "tui.json";
/** Main opencode config file name under OPENCODE_CONFIG_DIR. */
const OPENCODE_CONFIG_FILE = "opencode.json";
/** KV state file used by the opencode TUI for per-feature signals. */
const OPENCODE_KV_FILE = "kv.json";
/** Branding TUI plugin directory name inside the isolated opencode config. */
const OPENCODE_BRANDING_PLUGIN = "dsh-oc-logo";
/**
* Verified opencode 1.18.18 switches that disable background update checks,
* remote model catalog fetches and LSP binary downloads. Set before the child
* process spawns; the values are read from the process environment.
*/
const OPENCODE_NETWORK_SAFETY_ENV = {
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_DISABLE_LSP_DOWNLOAD: "1"
};
/**
* Whether timestamps should be enabled for the opencode TUI child.
* Accepts `1`, `true`, `yes` and `on` (case-insensitive).
*/
function tuiTimestampsEnabled(env = process.env) {
	const value = env[DSH_OC_TUI_TIMESTAMPS]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}
function readJsonObject(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
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
function brandingSourceDir() {
	return fileURLToPath(new URL("../../tui-branding/", import.meta.url));
}
/**
* Seed the isolated opencode TUI state:
* - always copies the dsh-oc branding plugin into the config dir and lists it
*   in `tui.json` (replacing the OpenCode ASCII logo on the home screen);
* - when `DSH_OC_TUI_TIMESTAMPS=1`, additionally enables default timestamps
*   through `kv.json` and `tui.json` keybinds.
* Existing config/state values are preserved by merging.
*/
function prepareOpenCodeTuiState(dshHome, env = process.env) {
	const configDir = join(dshHome, "opencode", "config");
	const tuiConfigPath = join(configDir, OPENCODE_TUI_FILE);
	const pluginDir = join(configDir, "plugins", OPENCODE_BRANDING_PLUGIN);
	mkdirSync(configDir, { recursive: true });
	cpSync(brandingSourceDir(), pluginDir, {
		recursive: true,
		force: true
	});
	const tuiConfig = readJsonObject(tuiConfigPath);
	const pluginList = Array.isArray(tuiConfig.plugin) ? tuiConfig.plugin : [];
	const merged = {
		...tuiConfig,
		plugin: [.../* @__PURE__ */ new Set([...pluginList, pluginDir])]
	};
	if (tuiTimestampsEnabled(env)) merged.keybinds = {
		...typeof tuiConfig.keybinds === "object" && tuiConfig.keybinds !== null && !Array.isArray(tuiConfig.keybinds) ? tuiConfig.keybinds : {},
		session_toggle_timestamps: "ctrl+shift+t",
		messages_toggle_timestamps: "ctrl+shift+t"
	};
	writeFileSync(tuiConfigPath, `${JSON.stringify(merged, null, 2)}\n`);
	if (tuiTimestampsEnabled(env)) {
		const kvPath = join(dshHome, "opencode", "state", "opencode", OPENCODE_KV_FILE);
		mkdirSync(dirname(kvPath), { recursive: true });
		const kv = readJsonObject(kvPath);
		writeFileSync(kvPath, `${JSON.stringify({
			...kv,
			timestamps: "show"
		}, null, 2)}\n`);
	}
}
/**
* Seed the isolated opencode config with `autoupdate: false`, preserving any
* existing values. This is the config-level counterpart of
* `OPENCODE_DISABLE_AUTOUPDATE` and keeps the attach child from downloading or
* hot-replacing itself even if a future opencode version changes the env flag.
*/
function prepareOpenCodeConfig(dshHome) {
	const configDir = join(dshHome, "opencode", "config");
	const configPath = join(configDir, OPENCODE_CONFIG_FILE);
	mkdirSync(configDir, { recursive: true });
	const config = readJsonObject(configPath);
	writeFileSync(configPath, `${JSON.stringify({
		...config,
		autoupdate: false
	}, null, 2)}\n`);
}
/** oc-tui configuration schema; both fields are optional. */
const OcTuiConfig = z.object({
	/** Absolute path override for the opencode binary (test/debug friendly). */
	binary: z.string().optional(),
	/** Extra arguments appended before the dsh command line arguments. */
	args: z.array(z.string()).optional()
}).default({});
/** Spawn `opencode attach` with stdio inherit and signal/termination helpers. */
function startOpenCodeTui(options) {
	const bridgeUrl = options.bridge.url.length > 0 ? options.bridge.url : `http://127.0.0.1:${options.bridge.port}`;
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	if (options.tuiArgs.includes("--mini")) process.stdout.write(`${renderMiniBrand()}\n`);
	const spawnImpl = options.spawn ?? defaultSpawn;
	const setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => {
		if (handle !== void 0) clearTimeout(handle);
	});
	const killTimeoutMs = options.killTimeoutMs ?? 5e3;
	const child = spawnImpl(options.bin, [
		"attach",
		bridgeUrl,
		...options.tuiArgs
	], {
		cwd,
		stdio: "inherit",
		env
	});
	let exited = false;
	let killTimer;
	child.on("error", (error) => {
		if (exited) return;
		exited = true;
		clearTimeoutImpl(killTimer);
		options.onError?.(error);
	});
	child.on("exit", (code, signal) => {
		if (exited) return;
		exited = true;
		clearTimeoutImpl(killTimer);
		const exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
		options.onExit?.(exitCode);
	});
	return {
		child,
		forward(signal) {
			if (!exited) child.kill(signal);
		},
		terminate() {
			if (exited) return;
			child.kill("SIGTERM");
			killTimer = setTimeoutImpl(() => {
				if (!exited) child.kill("SIGKILL");
			}, killTimeoutMs);
		}
	};
}
const defaultSpawn = (command, args, options) => {
	return spawn(command, args, options);
};
/**
* Forward parent SIGINT/SIGTERM to the running child without force-killing.
* @param processLike - process or fake process.
* @param getRunning - returns the current running TUI, if any.
* @param signals - signals to forward.
* @returns a disposer removing the listeners.
*/
function installSignalForwarding(processLike, getRunning, signals = ["SIGINT", "SIGTERM"]) {
	const handlers = [];
	for (const signal of signals) {
		const listener = () => getRunning()?.forward(signal);
		processLike.on(signal, listener);
		handlers.push({
			signal,
			listener
		});
	}
	return () => {
		for (const { signal, listener } of handlers.splice(0)) processLike.removeListener(signal, listener);
	};
}
/** Supported `opencode attach` flags passed through unchanged. */
const BOOLEAN_TUI_ARGS = /* @__PURE__ */ new Set([
	"--continue",
	"-c",
	"--fork",
	"--mini",
	"--print-logs"
]);
const VALUE_TUI_ARGS = /* @__PURE__ */ new Set([
	"--session",
	"-s",
	"--dir",
	"--log-level"
]);
/**
* Filter dsh app arguments into opencode `attach` arguments.
* Unknown/malformed arguments are reported, never silently dropped.
*/
function filterSupportedArgs(args) {
	const pass = [];
	const ignored = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const equalsAt = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg;
		if (BOOLEAN_TUI_ARGS.has(name)) {
			pass.push(arg);
			continue;
		}
		if (VALUE_TUI_ARGS.has(name)) {
			if (equalsAt >= 0) {
				pass.push(arg);
				continue;
			}
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) {
				pass.push(arg, value);
				index++;
				continue;
			}
			ignored.push(arg);
			continue;
		}
		ignored.push(arg);
	}
	return {
		pass,
		ignored
	};
}
/** Extract the `--dir <path>` / `--dir=<path>` value from raw dsh args. */
function tuiDirFromArgs(args) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--dir") {
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) return value;
			continue;
		}
		if (arg.startsWith("--dir=")) return arg.slice(6);
	}
}
/** Extract the `--session <id>` / `-s <id>` / `--session=<id>` value. */
function tuiSessionFromArgs(args) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--session" || arg === "-s") {
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) return value;
			continue;
		}
		if (arg.startsWith("--session=")) return arg.slice(10);
	}
}
/** Resolve and validate an attach `--dir` value before handing it to opencode. */
function resolveTuiDir(dir) {
	const resolved = resolve(dir);
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		throw new Error(`--dir path does not exist: ${resolved}`);
	}
	if (!stat.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
	return resolved;
}
/**
* Build the child environment: inherit the parent and isolate opencode state
* under `$DSH_HOME/opencode`. `OPENCODE_CONFIG_CONTENT` is intentionally
* never introduced.
*/
function buildChildEnv(env = process.env, dshHome = resolveDshHome()) {
	const childEnv = {
		...env,
		...OPENCODE_NETWORK_SAFETY_ENV,
		OPENCODE_CONFIG_DIR: join(dshHome, "opencode", "config"),
		XDG_CONFIG_HOME: join(dshHome, "opencode", "config"),
		XDG_DATA_HOME: join(dshHome, "opencode", "data"),
		XDG_STATE_HOME: join(dshHome, "opencode", "state"),
		XDG_CACHE_HOME: join(dshHome, "opencode", "cache")
	};
	if (tuiTimestampsEnabled(env)) childEnv.OPENCODE_TUI_CONFIG = join(dshHome, "opencode", "config", OPENCODE_TUI_FILE);
	delete childEnv.OPENCODE_CONFIG_CONTENT;
	return childEnv;
}
/**
* Request a bounded process exit through `ctx.appExit` when available.
* @param ctx - context with an optional `appExit`.
* @param code - desired exit code.
* @param fallback - exit-code setter used when no `appExit` exists.
* @returns true when `ctx.appExit` handled the request.
*/
function requestExit(ctx, code, fallback = (value) => {
	process.exitCode = value;
}) {
	const exit = ctx.get("appExit");
	if (typeof exit === "function") {
		exit(code);
		return true;
	}
	fallback(code);
	return false;
}
/**
* One-line clarification printed after the opencode mini TUI exits. The
* banner above belongs to the official opencode binary; the printed session
* id is a dsh session id and must be resumed through dsh, not opencode.
*/
function ocExitNote() {
	return "[dsh-oc] 上面是 opencode 的退出提示；session id 是 dsh 会话 id，恢复请使用 dsh --profile oc --session <id>，不要直接运行 opencode 的恢复命令";
}
/**
* Whether the exit hint is enabled. Set `DSH_OC_DISABLE_EXIT_NOTE=1` to turn
* it off for users who do not want the extra line after the TUI exits.
*/
function exitNoteEnabled(env = process.env) {
	const value = env.DSH_OC_DISABLE_EXIT_NOTE?.toLowerCase();
	return value !== "1" && value !== "true" && value !== "yes" && value !== "on";
}
/**
* Test/debug helper resolving the binary without spawning the TUI.
* Accepts either resolver deps or a context-like object carrying `config.binary`.
*/
async function resolveOpenCodeBinary(input = {}) {
	const { config, ...deps } = input;
	return resolveOpenCodeBinary$1({
		...deps,
		...config?.binary !== void 0 ? { binaryOverride: config.binary } : {}
	});
}
/**
* The oc-tui Cordis service. Mounts after `ocBridge` and owns the child's
* lifetime, signal forwarding, and exit handoff.
*/
var OcTuiService = class extends Service {
	config;
	static inject = ["ocBridge"];
	static Config = OcTuiConfig;
	running;
	removeSignalForwarding;
	constructor(ctx, config) {
		super(ctx, "ocTui");
		this.config = config;
		this.removeSignalForwarding = installSignalForwarding(process, () => this.running);
		ctx.effect(() => () => this.running?.terminate(), "ocTui.childTeardown");
		ctx.effect(() => () => this.removeSignalForwarding(), "ocTui.signalDisposer");
	}
	async [Service.init]() {
		const bridge = this.ctx.get("ocBridge");
		if (bridge === void 0) throw new Error("oc-tui: ocBridge service is unavailable");
		const rawArgs = [...this.config.args ?? [], ...this.ctx.cmdlineArgs?.get() ?? []];
		if (helpRequested(rawArgs)) {
			process.stdout.write(ocHelp());
			requestExit(this.ctx, 0);
			return;
		}
		const dirArg = tuiDirFromArgs(rawArgs);
		if (dirArg !== void 0) try {
			bridge.setCwd?.(resolveTuiDir(dirArg));
		} catch (error) {
			this.fail(error);
			return;
		}
		const sessionId = tuiSessionFromArgs(rawArgs);
		if (sessionId !== void 0) bridge.prefetchSession?.(sessionId);
		let resolved;
		try {
			resolved = await resolveOpenCodeBinary({
				env: process.env,
				binaryOverride: this.config.binary
			});
			if (process.env.DSH_OC_BYPASS_VERSION_CHECK === "1") this.ctx.logger.warn?.(`[dsh-oc] version check bypassed for ${resolved.bin}`);
			else await verifyOpenCodeVersion(resolved.bin);
		} catch (error) {
			this.fail(error);
			return;
		}
		const { pass: tuiArgs, ignored } = filterSupportedArgs(rawArgs);
		for (const arg of ignored) process.stderr.write(`[dsh-oc] ignored unsupported arg: ${arg}\n`);
		const dshHome = resolveDshHome();
		const childEnv = buildChildEnv(process.env, dshHome);
		for (const dir of [
			join(dshHome, "opencode", "config"),
			join(dshHome, "opencode", "data"),
			join(dshHome, "opencode", "state"),
			join(dshHome, "opencode", "cache")
		]) mkdirSync(dir, { recursive: true });
		prepareOpenCodeConfig(dshHome);
		prepareOpenCodeTuiState(dshHome, process.env);
		try {
			this.running = startOpenCodeTui({
				bin: resolved.bin,
				bridge,
				tuiArgs,
				cwd: process.cwd(),
				env: childEnv,
				onExit: async (code) => {
					const needed = bridge.exitNoteNeeded ? await bridge.exitNoteNeeded().catch(() => false) : bridge.hasNewActivity?.() ?? false;
					if (exitNoteEnabled(process.env) && needed) process.stdout.write(`${ocExitNote()}\n`);
					requestExit(this.ctx, code);
				},
				onError: (error) => {
					this.ctx.logger.error(error);
					requestExit(this.ctx, 1);
				}
			});
		} catch (error) {
			this.fail(error);
		}
	}
	fail(error) {
		const message = error instanceof Error ? error.message : String(error);
		this.ctx.logger.error(message);
		process.stderr.write(`[dsh-oc] ${message}\n`);
		requestExit(this.ctx, 1);
	}
};
//#endregion
export { DSH_OC_TUI_TIMESTAMPS, OPENCODE_BRANDING_PLUGIN, OPENCODE_CONFIG_FILE, OPENCODE_KV_FILE, OPENCODE_NETWORK_SAFETY_ENV, OPENCODE_TUI_FILE, OcTuiConfig, OcTuiService, OcTuiService as default, brandingSourceDir, buildChildEnv, exitNoteEnabled, filterSupportedArgs, helpRequested, installSignalForwarding, ocExitNote, ocHelp, prepareOpenCodeConfig, prepareOpenCodeTuiState, requestExit, resolveAssetUrl, resolveOpenCodeBinary, resolveTuiDir, startOpenCodeTui, tuiDirFromArgs, tuiSessionFromArgs, tuiTimestampsEnabled };

//# sourceMappingURL=index.js.map