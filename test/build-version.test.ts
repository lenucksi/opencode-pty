import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { describeBuild, UNKNOWN_BUILD } from '../src/shared/build-info.ts'
import {
  BUILD_INFO_PATH,
  createGitProbe,
  readBuildInfo,
  renderBuildInfo,
  writeBuildInfo,
} from '../scripts/version.ts'
import {
  findBuildInfo,
  findPackageVersion,
  parseBuildInfo,
} from '../src/plugin/pty/read-build-info.ts'

/**
 * The build identity is stamped into `dist/` at build time rather than read from
 * Git at runtime, because the runtime copy is an installed package with no
 * `.git`. That makes the generator and the reader the only two places the value
 * can be wrong, and it can be wrong quietly: a hash of `null` renders, ships, and
 * reports nothing.
 */

const tempRoots: string[] = []

describe('describeBuild', () => {
  it('puts the version first and the commit in parentheses', () => {
    expect(describeBuild({ version: '0.4.0', commit: 'abc1234', dirty: false })).toBe(
      '0.4.0 (abc1234)'
    )
  })

  it('shows the version alone when the commit is unknown', () => {
    // A bare version is still useful; a fabricated hash is not.
    expect(describeBuild({ version: '0.4.0', commit: null, dirty: false })).toBe('0.4.0')
  })

  it('marks a dirty build in the commit, so it is visible in a bug report', () => {
    expect(describeBuild({ version: '0.4.0', commit: 'abc1234-dirty', dirty: true })).toBe(
      '0.4.0 (abc1234-dirty)'
    )
  })

  it('never renders an empty version as an empty label', () => {
    expect(describeBuild({ version: '', commit: null, dirty: false })).toBe(UNKNOWN_BUILD.version)
  })
})

describe('readBuildInfo', () => {
  it('takes the version from package.json', () => {
    const info = readBuildInfo(() => 'abc1234')
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('records the short hash git reports', () => {
    // `rev-parse --short` is 7 characters by default; a longer one would mean the
    // flag stopped being passed. The probe answers only for `rev-parse`, because
    // the contract is that it returns null for a command with no output.
    const probe = (command: string[]): string | null =>
      command[0] === 'rev-parse' ? 'abc1234' : null
    expect(readBuildInfo(probe).commit).toBe('abc1234')
  })

  it('marks a checkout with uncommitted changes', () => {
    const probe = (command: string[]): string | null =>
      command[0] === 'status' ? ' M src/index.ts' : 'abc1234'
    const info = readBuildInfo(probe)

    expect(info.dirty).toBe(true)
    // Half a truth: "abc1234" from a build that also had local edits sends
    // someone to a commit that does not contain the code they are looking at.
    expect(info.commit).toBe('abc1234-dirty')
  })

  it('reports no commit when there is no git checkout', () => {
    const info = readBuildInfo(() => null)

    expect(info.commit).toBeNull()
    expect(info.dirty).toBe(false)
    // The version still comes through: package.json is there even without git.
    expect(info.version).not.toBe(UNKNOWN_BUILD.version)
  })

  it('does not claim to be dirty when there are no local changes', () => {
    // `git status --porcelain` prints nothing on a clean checkout, which the
    // probe reports as null. Counting that empty output as an answer would label
    // every clean build dirty.
    const probe = (command: string[]): string | null =>
      command[0] === 'rev-parse' ? 'abc1234' : null
    const info = readBuildInfo(probe)

    expect(info.dirty).toBe(false)
    expect(info.commit).toBe('abc1234')
  })
})

describe('the real git probe', () => {
  it('calls a clean checkout clean', () => {
    // The decisive case, and the reason the probe is a factory: a fresh
    // repository with one committed file and no local edits. `git status
    // --porcelain` prints nothing here, and a probe that passed that empty
    // output on as an answer would label every clean build dirty.
    const root = mkdtempSync(join(tmpdir(), 'pty-git-clean-'))
    tempRoots.push(root)
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
    }
    git(['init', '--quiet'])
    git(['config', 'user.email', 'test@example.invalid'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'committed\n')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'initial'])

    const probe = createGitProbe(root)
    expect(probe(['status', '--porcelain'])).toBeNull()
    expect(probe(['rev-parse', '--short', 'HEAD'])).toMatch(/^[0-9a-f]{7,}$/)

    // And the same repository with a local edit.
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    expect(probe(['status', '--porcelain'])).toContain('a.txt')
  })

  it('composes with readBuildInfo on a clean checkout', () => {
    // The end-to-end shape: real probe, real generator, clean repository. A clean
    // build must not be labelled dirty, and a real one must be.
    const root = mkdtempSync(join(tmpdir(), 'pty-git-composed-'))
    tempRoots.push(root)
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
    }
    git(['init', '--quiet'])
    git(['config', 'user.email', 'test@example.invalid'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'committed\n')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'initial'])

    const probe = createGitProbe(root)
    const clean = readBuildInfo(probe)
    expect(clean.dirty).toBe(false)
    expect(clean.commit).toMatch(/^[0-9a-f]{7,}$/)

    writeFileSync(join(root, 'b.txt'), 'uncommitted\n')
    const dirty = readBuildInfo(probe)
    expect(dirty.dirty).toBe(true)
    expect(dirty.commit?.endsWith('-dirty')).toBe(true)
  })

  it('reports nothing for a directory that is not a checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-git-none-'))
    tempRoots.push(root)

    expect(createGitProbe(root)(['rev-parse', '--short', 'HEAD'])).toBeNull()
  })

  it('labels this checkout the way git does, in whatever state it is in', () => {
    // The fakes above pin the contract and the temp repository above pins the
    // composition. What is left for the shipped probe is that it agrees with git
    // about the *real* checkout it will be asked about.
    //
    // An earlier version of this asserted `dirty === true` and explained it with
    // "this worktree has uncommitted changes". That made the test a snapshot of
    // whatever the tree happened to look like: it failed on a clean checkout,
    // passed on a dirty one, and would have passed just as happily with a probe
    // that always answered "dirty". Comparing against `git status` asks the
    // question that actually matters and is true in both states.
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    expect(status.status).toBe(0)
    const actuallyDirty = status.stdout.trim() !== ''

    const info = readBuildInfo(createGitProbe(dirname(dirname(BUILD_INFO_PATH))))

    expect(info.version).not.toBe(UNKNOWN_BUILD.version)
    expect(info.commit).toMatch(/^[0-9a-f]{7,}(-dirty)?$/)
    expect(info.dirty).toBe(actuallyDirty)
    expect(info.commit?.endsWith('-dirty')).toBe(actuallyDirty)
  })
})

describe('the stamp', () => {
  it('is JSON the runtime can parse straight back', () => {
    // The stamp is the wire format now, so the round trip is the contract.
    const info = { version: '2.0.0', commit: 'deadbee', dirty: true }
    expect(parseBuildInfo(renderBuildInfo(info))).toEqual(info)
  })

  it('round-trips a stamp with no commit', () => {
    const info = { version: '2.0.0', commit: null, dirty: false }
    expect(parseBuildInfo(renderBuildInfo(info))).toEqual(info)
  })

  it('round-trips a stamp with a version containing a quote', () => {
    // JSON escaping is not the place for cleverness, and the version is read from
    // a manifest a human edited.
    const info = { version: "it's 1.0", commit: null, dirty: false }
    expect(parseBuildInfo(renderBuildInfo(info))).toEqual(info)
  })

  it('ends with a newline, so the file is well-formed', () => {
    expect(renderBuildInfo(UNKNOWN_BUILD).endsWith('\n')).toBe(true)
  })

  it('writes under dist/, where generated output belongs', () => {
    // The point of the placement: a stamp in the source tree changes on every
    // build, which leaves the tree dirty and blocks every branch switch. That
    // cost a merge before it was noticed, so it is pinned here rather than left
    // to a code review.
    expect(BUILD_INFO_PATH.endsWith(join('dist', 'build-info.json'))).toBe(true)
    expect(BUILD_INFO_PATH).not.toContain(`${join('src', '')}`)
  })

  it('writes somewhere git ignores, so a build leaves no trace in the tree', () => {
    // The property that makes the placement worth having: after a build, nothing
    // under version control has moved, so a branch switch cannot be blocked and no
    // commit accidentally records a hash.
    // The tests run from the repository root, so this is the same path the
    // .gitignore rule names.
    const fromRoot = relative(process.cwd(), BUILD_INFO_PATH)
    const ignored = spawnSync('git', ['check-ignore', '-q', fromRoot], { encoding: 'utf8' })

    expect(fromRoot).toBe(join('dist', 'build-info.json'))
    expect(ignored.status).toBe(0)
  })

  it('creates dist/ when it is not there yet', () => {
    // `bun clean` removes dist earlier in the same build, so the directory is
    // usually missing when the stamp is written.
    const root = mkdtempSync(join(tmpdir(), 'pty-stamp-'))
    tempRoots.push(root)
    const target = join(root, 'nested', 'dist', 'build-info.json')

    writeBuildInfo(UNKNOWN_BUILD, target)

    expect(readFileSync(target, 'utf8')).toBe(renderBuildInfo(UNKNOWN_BUILD))
  })

  it('finds the stamp from a checkout, where it lives under dist/', () => {
    // The layout that actually exists when the tests run: source under `<repo>/src`,
    // stamp at `<repo>/dist`. An earlier version of this test put the stamp in the
    // repository root, so it passed against a search that could not find the real
    // file - and the E2E server reported `unknown` because of it.
    const root = mkdtempSync(join(tmpdir(), 'pty-find-checkout-'))
    tempRoots.push(root)
    const src = join(root, 'src', 'plugin', 'pty')
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(root, 'dist', 'build-info.json'),
      renderBuildInfo({ version: '9.9.9', commit: 'abc1234', dirty: false })
    )

    expect(findBuildInfo(src)).toEqual({ version: '9.9.9', commit: 'abc1234', dirty: false })
  })

  it('finds the stamp from the compiled package, where it sits beside the code', () => {
    // The other real layout: `dist/src/...` running with the stamp at `dist/`.
    // A separate candidate path, so a search that only handles the first silently
    // reports "unknown" in a published install.
    const root = mkdtempSync(join(tmpdir(), 'pty-find-dist-'))
    tempRoots.push(root)
    const compiled = join(root, 'dist', 'src', 'web', 'server', 'handlers')
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(compiled, { recursive: true })
    writeFileSync(
      join(root, 'dist', 'build-info.json'),
      renderBuildInfo({ version: '8.8.8', commit: 'beef123', dirty: false })
    )

    expect(findBuildInfo(compiled)).toEqual({ version: '8.8.8', commit: 'beef123', dirty: false })
  })

  it('falls back to unknown when no stamp is anywhere above', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-nostamp-'))
    tempRoots.push(root)

    expect(findBuildInfo(root)).toEqual(UNKNOWN_BUILD)
  })

  it('reads the version from a manifest above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-manifest-'))
    tempRoots.push(root)
    const deep = join(root, 'src', 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.1.4' }))

    expect(findPackageVersion(deep)).toBe('3.1.4')
  })

  it('skips a corrupt stamp instead of taking the server down', () => {
    // A cosmetic value is not worth an exception on the path of every request.
    expect(parseBuildInfo('{not json')).toBeNull()
    expect(parseBuildInfo('[]')).toBeNull()
    expect(parseBuildInfo('{"commit":"abc1234","dirty":false}')).toBeNull()
    expect(parseBuildInfo('{"version":"1.0.0","commit":7,"dirty":false}')).toBeNull()
    expect(parseBuildInfo('{"version":"1.0.0","commit":null}')).toBeNull()
  })

  it('prefers the nearest stamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-nearest-'))
    tempRoots.push(root)
    const near = join(root, 'dist')
    mkdirSync(near, { recursive: true })
    writeFileSync(
      join(root, 'build-info.json'),
      renderBuildInfo({
        version: '1.0.0',
        commit: null,
        dirty: false,
      })
    )
    writeFileSync(
      join(near, 'build-info.json'),
      renderBuildInfo({
        version: '2.0.0',
        commit: null,
        dirty: false,
      })
    )

    // A stale stamp in an outer directory must not shadow the current one.
    expect(findBuildInfo(near).version).toBe('2.0.0')
  })

  it('leaves no temp dirs behind', () => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    expect(tempRoots).toHaveLength(0)
  })
})
