import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * OpenTUI 0.5.x embeds its native renderer as a Bun `type: "file"` asset.
 * Bun 1.3.x materializes that asset as `.<hash>-00000000.<ext>` in the
 * process temp directory and does not remove it. Keep those files in a
 * dsh-owned, per-process directory so a renderer leak cannot fill the shared
 * system `/tmp` (or another user's quota).
 */
const OPENCODE_TMP_ROOT = 'tmp'
const TUI_TMP_PREFIX = 'tui-'
const NATIVE_TEMP_FILE = /^\.[0-9a-f]+-00000000\.(?:so|dylib|dll|node)$/i
const TUI_TMP_DIR = /^tui-(\d+)$/

export function opencodeTuiTempDir(dshHome: string, pid = process.pid): string {
  return join(dshHome, 'opencode', OPENCODE_TMP_ROOT, `${TUI_TMP_PREFIX}${pid}`)
}

/** Whether a process id still belongs to a live process. Injectable in tests. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove only the native files known to be produced by OpenTUI's Bun loader.
 * Unknown files are deliberately left untouched because this directory also
 * hosts download transaction files used by the binary resolver.
 */
export function cleanupOpenCodeNativeTemp(directory: string): number {
  if (!existsSync(directory)) return 0
  let removed = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true }) as Dirent[]
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile() || !NATIVE_TEMP_FILE.test(entry.name)) continue
    try {
      unlinkSync(join(directory, entry.name))
      removed++
    } catch {
      // A concurrently loaded native file may be undeletable (notably on
      // Windows); leave it for the next startup/exit cleanup pass.
    }
  }
  return removed
}

/**
 * Prepare this run's isolated OpenTUI temp directory and reap directories
 * left by dsh processes that are no longer alive. The liveness check is
 * injectable so cleanup behavior stays deterministic in unit tests.
 */
export function prepareOpenCodeTemp(
  dshHome: string,
  pid = process.pid,
  isAlive: (pid: number) => boolean = processAlive,
): string {
  const root = join(dshHome, 'opencode', OPENCODE_TMP_ROOT)
  mkdirSync(root, { recursive: true })
  try {
    for (const entry of readdirSync(root, { withFileTypes: true }) as Dirent[]) {
      if (!entry.isDirectory()) continue
      const match = TUI_TMP_DIR.exec(entry.name)
      if (match === null || Number(match[1]) === pid) continue
      const ownerPid = Number(match[1])
      if (isAlive(ownerPid)) continue
      try {
        rmSync(join(root, entry.name), { recursive: true, force: true })
      } catch {
        // Cleanup is best effort; the current process can still start safely.
      }
    }
  } catch {
    // A read failure must not prevent the TUI from starting.
  }
  const current = opencodeTuiTempDir(dshHome, pid)
  mkdirSync(current, { recursive: true })
  cleanupOpenCodeNativeTemp(current)
  return current
}
