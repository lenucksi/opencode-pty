import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildInfo } from '../src/shared/build-info.ts'

/**
 * Stamps `dist/build-info.json` from `package.json` and the Git checkout.
 *
 * Baked in at build time rather than read from Git at runtime, because the
 * runtime copy is an installed package: `node_modules/opencode-pty` has no
 * `.git`. Baking it in also means the published tarball carries the provenance of
 * the commit it was built from, which is the point of showing it - a human filing
 * a bug report needs to name a commit that contains the code they are looking at.
 *
 * Written under `dist/` rather than into `src/`, and that placement is the whole
 * design. A generated module in the source tree changes on every build, which
 * leaves the working tree dirty after every build and blocks every branch switch
 * - a generated file that has to be committed is a generated file in the wrong
 * place. `dist` is also the only thing the published package ships, so the stamp
 * travels with the artifact without anyone committing a hash to record it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

export const BUILD_INFO_PATH = join(repoRoot, 'dist', 'build-info.json')

function readVersion(repoRootDir: string): string {
  try {
    const raw = readFileSync(join(repoRootDir, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version
      if (typeof version === 'string' && version !== '') return version
    }
  } catch {
    // A build that cannot read its own manifest should still produce a stamp.
  }
  return '0.0.0-dev'
}

/**
 * Runs a Git command and returns its trimmed stdout.
 *
 * Returns `null` when the command failed **or printed nothing**. Both mean "no
 * answer", and the caller must not have to tell them apart: a probe that answers
 * `''` for `git status` on a clean checkout would otherwise read as "uncommitted
 * changes", which is exactly backwards.
 */
export type GitProbe = (command: string[]) => string | null

/**
 * A probe that runs Git in a given directory.
 *
 * A factory rather than a module-level closure because the directory is what
 * makes it testable: a temporary repository can be made clean on demand, which is
 * the only way to check that an empty `git status` is not mistaken for local
 * changes. Hardwiring the module's own root would put that case out of reach.
 */
export function createGitProbe(cwd: string): GitProbe {
  return (command) => {
    try {
      // `spawnSync` rather than `execSync`: no shell, no quoting question, and it
      // cannot hang waiting for input. The timeout covers a Git blocked on a lock
      // or a credential prompt, which would otherwise hang the whole build.
      const result = spawnSync('git', command, { cwd, encoding: 'utf8', timeout: 5_000 })
      if (result.status !== 0) return null
      const out = result.stdout.trim()
      return out === '' ? null : out
    } catch {
      return null
    }
  }
}

const defaultGitProbe: GitProbe = createGitProbe(repoRoot)

/**
 * Read the build identity from a checkout.
 *
 * `dirty` is folded into the hash the way `git describe --dirty` does, because
 * "commit abc1234" from a build that also had uncommitted changes is a
 * half-truth that costs someone an afternoon.
 */
export function readBuildInfo(probe: GitProbe = defaultGitProbe): BuildInfo {
  const version = readVersion(repoRoot)
  const commit = probe(['rev-parse', '--short', 'HEAD'])
  if (commit === null) return { version, commit: null, dirty: false }
  const dirty = probe(['status', '--porcelain']) !== null
  return { version, commit: dirty ? `${commit}-dirty` : commit, dirty }
}

/** Render the stamp. Pure, so the output is testable on its own. */
export function renderBuildInfo(info: BuildInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`
}

export function writeBuildInfo(info: BuildInfo, target: string = BUILD_INFO_PATH): void {
  // `dist` is removed by `bun clean` earlier in the same build, so the directory
  // is usually not there yet.
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderBuildInfo(info))
}

if (import.meta.main) {
  const info = readBuildInfo()
  writeBuildInfo(info)
  // One line, because a build log that says nothing about the artifact it just
  // produced is how "which version is this?" becomes a five-minute question.
  console.log(
    `[version] ${info.version}${info.commit ? ` (${info.commit})` : ' (no git checkout)'}`
  )
}
