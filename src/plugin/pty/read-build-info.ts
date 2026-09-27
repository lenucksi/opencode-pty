import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UNKNOWN_BUILD, type BuildInfo } from '../../shared/build-info.ts'

/**
 * Reads the build identity that the build stamped into `dist/`.
 *
 * Why a lookup instead of an import: a generated module in the source tree
 * changes on every build, which leaves the working tree dirty after every build
 * and blocks every branch switch. A file under `dist/` is where generated output
 * belongs, and `dist` is already the only thing the published package ships, so
 * the stamp travels with it without anyone having to commit a hash.
 *
 * The search walks up from this file because the same code runs from two places:
 * from `src/` while the tests import it, and from `dist/src/` once compiled. A
 * fixed number of levels up would be one line shorter and would break the moment
 * either layout moved a directory.
 */

const MAX_LEVELS = 8

/** Reads a file's contents, or null when it is missing or unreadable. */
export type FileReader = (path: string) => string | null

const readFileOrNull: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Candidate stamp paths for a directory, nearest first.
 *
 * Two shapes, because the same code runs from two layouts: from a checkout, where
 * the stamp is at `<repo>/dist/build-info.json`, and from the compiled package,
 * where it sits beside the running code in `dist/`. Checking only one of them
 * means the other silently reports "unknown" - which is what happened, and the
 * test that should have caught it had invented a third layout.
 */
function stampCandidates(dir: string): string[] {
  return [join(dir, 'dist', 'build-info.json'), join(dir, 'build-info.json')]
}

/**
 * Nearest stamp at or above `fromDir`.
 *
 * A stamp that does not parse is skipped rather than thrown: a corrupt cosmetic
 * value should degrade to "unknown", not take the web UI down.
 */
export function findBuildInfo(fromDir: string, read: FileReader = readFileOrNull): BuildInfo {
  let dir = resolve(fromDir)
  for (let level = 0; level < MAX_LEVELS; level++) {
    for (const candidate of stampCandidates(dir)) {
      const raw = read(candidate)
      if (raw === null) continue
      const parsed = parseBuildInfo(raw)
      if (parsed !== null) return parsed
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return UNKNOWN_BUILD
}

/** Nearest `package.json` version at or above `fromDir`. */
export function findPackageVersion(fromDir: string, read: FileReader = readFileOrNull): string {
  let dir = resolve(fromDir)
  for (let level = 0; level < MAX_LEVELS; level++) {
    const raw = read(join(dir, 'package.json'))
    if (raw !== null) {
      const parsed = parsePackageVersion(raw)
      if (parsed !== null) return parsed
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return UNKNOWN_BUILD.version
}

/** Parse a stamp, or null when it is not one. */
export function parseBuildInfo(raw: string): BuildInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const { version, commit, dirty } = parsed as Record<string, unknown>
  if (typeof version !== 'string') return null
  if (commit !== null && typeof commit !== 'string') return null
  if (typeof dirty !== 'boolean') return null
  return { version, commit, dirty }
}

function parsePackageVersion(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version
      if (typeof version === 'string' && version !== '') return version
    }
  } catch {
    // A manifest that does not parse is not worth failing over here.
  }
  return null
}

let cached: BuildInfo | null = null

/**
 * The build identity of the running server.
 *
 * Cached because the handler is on the path of every `/api/server` request and
 * the answer cannot change while the process lives.
 */
export function currentBuildInfo(): BuildInfo {
  cached ??= resolveBuildInfo()
  return cached
}

/** Test seam: forces the next `currentBuildInfo` to re-read from disk. */
export function resetBuildInfoCache(): void {
  cached = null
}

function resolveBuildInfo(): BuildInfo {
  const here = dirname(fileURLToPath(import.meta.url))
  const stamped = findBuildInfo(here)
  if (stamped !== UNKNOWN_BUILD) return stamped

  // No stamp: either the code runs straight from a checkout that was never built,
  // or the stamp went missing. The version is still knowable from the manifest,
  // and reporting it is better than reporting nothing.
  const version = findPackageVersion(here)
  return { version, commit: null, dirty: false }
}
