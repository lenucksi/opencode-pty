import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * What the HOST runs, as opposed to what this repository builds.
 *
 * Two independent things stand between a green build and a live fix, and both have already
 * cost a round of testing.
 *
 * 1. The host resolves the plugin by NAME, not by path. The wrapper in
 *    `~/.config/opencode/plugins/opencode-pty/` re-exports `opencode-pty/v2/tui`, and
 *    `~/.config/opencode/package.json` declares `"opencode-pty": "file:/…/opencode-pty"`.
 *    A `file:` dependency installs a COPY - different inodes, `links=1` - so the host went
 *    on running a `dist` from two hours before the fix while the working tree was clean and
 *    the gate was green. Reported as "the fix did nothing", which is exactly what it was.
 * 2. Even a correctly linked plugin runs the last BUILD. Editing `src/` without building
 *    leaves the artifact untouched, and the symptom is the same unhelpful silence.
 *
 * So one case asks whether the host's name resolves into this repository, and one asks
 * whether the artifact is newer than the sources it is built from. Both skip where they do
 * not apply - CI has no `~/.config/opencode`, and a fresh checkout may carry no `dist` - and
 * both FAIL, loudly, on a developer machine where the invariant is broken. A guard that
 * skipped everywhere would be worse than none, because it would read like coverage.
 */

const REPO = resolve(import.meta.dir, '..')

/** The directory the host probes for a plugin's two halves. */
const WRAPPER_DIR = join(process.env.HOME ?? '', '.config/opencode/plugins/opencode-pty')

const wrapperPresent = existsSync(WRAPPER_DIR)

/**
 * Whether `path` is inside the repository.
 *
 * `relative` rather than `startsWith`, so a sibling whose name merely BEGINS with the
 * repository's - `opencode-pty-backup` next to `opencode-pty` - is not mistaken for it.
 */
function isInsideRepo(path: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(REPO, path)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

describe('the TUI half the host loads', () => {
  it.skipIf(!wrapperPresent)('resolves into this working tree, not into an installed copy', () => {
    const resolved = Bun.resolveSync('opencode-pty/v2/tui', join(WRAPPER_DIR, 'tui.ts'))
    // The PATH, not the contents: a copy of this package inside the host's own
    // node_modules is byte-identical and still a different artifact, which is why
    // grepping the loaded file for a new string is not a check either.
    expect({ resolved, insideRepo: isInsideRepo(resolved) }).toEqual({
      resolved,
      insideRepo: true,
    })
  })

  it.skipIf(!wrapperPresent)('resolves the server half into this working tree too', () => {
    const resolved = Bun.resolveSync('opencode-pty/v2', join(WRAPPER_DIR, 'index.ts'))
    expect({ resolved, insideRepo: isInsideRepo(resolved) }).toEqual({
      resolved,
      insideRepo: true,
    })
  })

  // Stated on its own because it is the fact that made the stale copy invisible: the
  // wrapper names the PACKAGE, so nothing in the host's configuration points at the
  // directory the code was edited in.
  it.skipIf(!wrapperPresent)('is reached through a wrapper directory, not a lone file', () => {
    expect(readdirSync(WRAPPER_DIR)).toContain('tui.ts')
  })
})

/** Every file under `dir` ending in `ext`, recursively. */
function filesUnder(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path, ext))
    else if (entry.name.endsWith(ext)) found.push(path)
  }
  return found
}

describe('the built artifact', () => {
  const sources = filesUnder(join(REPO, 'src'), '.ts')
  const artifacts = filesUnder(join(REPO, 'dist'), '.js')

  it.skipIf(artifacts.length === 0)('is newer than every source file it is built from', () => {
    // Newest source against OLDEST artifact, so one stale artifact is enough to fail.
    // A single one means the host would run code that no longer matches this tree.
    const oldestArtifactMs = Math.min(...artifacts.map((path) => statSync(path).mtimeMs))
    const staleSources = sources.filter((path) => statSync(path).mtimeMs > oldestArtifactMs)
    expect({
      checkedArtifacts: artifacts.length,
      staleSources: staleSources.map((path) => relative(REPO, path)),
    }).toEqual({ checkedArtifacts: artifacts.length, staleSources: [] })
  })
})
