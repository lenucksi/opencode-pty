import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeBuild, UNKNOWN_BUILD } from '../src/shared/build-info.ts'
import {
  createGitProbe,
  PLACEHOLDER,
  readBuildInfo,
  renderBuildInfo,
  writeBuildInfo,
} from '../scripts/version.ts'

/**
 * The build identity is baked in rather than read at runtime, because the runtime
 * copy is an installed package with no `.git`. That makes the generator the only
 * place the value can be wrong, and it can be wrong quietly: a hash of `null`
 * renders, ships, and reports nothing.
 */

const tempRoots: string[] = []

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'pty-version-'))
  tempRoots.push(root)
  return join(root, 'build-info.ts')
}

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
    expect(info.version).not.toBe(PLACEHOLDER.version)
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

  it('reports this checkout honestly, dirty included', () => {
    // The fakes above pin the contract; this pins that the shipped probe honours
    // it. `git status --porcelain` prints nothing on a clean checkout, and a probe
    // that returned that as an answer instead of null would label every clean
    // build dirty - the kind of wrong that is invisible until someone trusts it.
    const info = readBuildInfo()

    expect(info.version).not.toBe(PLACEHOLDER.version)
    expect(info.commit).toMatch(/^[0-9a-f]{7,}(-dirty)?$/)
    // This worktree has uncommitted changes, so the label has to say so.
    expect(info.dirty).toBe(true)
    expect(info.commit?.endsWith('-dirty')).toBe(true)
  })
})

describe('the generated module', () => {
  it('imports the shared type rather than restating it', () => {
    const source = renderBuildInfo({ version: '1.2.3', commit: 'abc1234', dirty: false })

    expect(source).toContain("import type { BuildInfo } from '../../shared/build-info.ts'")
    expect(source).toContain('export const BUILD_INFO: BuildInfo')
  })

  it('says it is generated, so nobody hand-edits it', () => {
    const source = renderBuildInfo(PLACEHOLDER)

    expect(source).toContain('do not edit by hand')
    expect(source).toContain('scripts/version.ts')
  })

  it('emits a null commit rather than a placeholder hash', () => {
    expect(renderBuildInfo(PLACEHOLDER)).toContain('"commit": null')
  })

  it('round-trips through a real file', () => {
    const target = tempFile()
    writeBuildInfo({ version: '2.0.0', commit: 'deadbee', dirty: true }, target)

    const written = readFileSync(target, 'utf8')
    expect(written).toContain('"version": "2.0.0"')
    expect(written).toContain('"commit": "deadbee"')
    expect(written).toContain('"dirty": true')
  })

  it('writes a module the committed placeholder can be replaced by', () => {
    // The committed file exists so a fresh clone typechecks; a build overwrites
    // it. Both have to be the same shape or the build breaks the checkout.
    const target = tempFile()
    writeBuildInfo(PLACEHOLDER, target)
    const source = readFileSync(target, 'utf8')

    expect(source).toBe(renderBuildInfo(PLACEHOLDER))
  })

  it('leaves no temp dirs behind', () => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    expect(tempRoots).toHaveLength(0)
  })
})
