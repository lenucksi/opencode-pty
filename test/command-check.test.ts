import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkExecutable, resolveCommand } from '../src/plugin/pty/command-check.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { manager } from '../src/plugin/pty/manager.ts'

/**
 * A command that cannot be executed is caught before the spawn.
 *
 * Found by an LLM-in-the-loop run: a model spawned `./gen.sh` on a file without
 * the execute bit, read `panic(main thread): abort() called` and `oh no: Bun has
 * crashed. This indicates a bug in Bun, not your code` out of the buffer, and
 * spent eight turns concluding the plugin was broken. The missing execute bit is
 * a `chmod +x` away and nothing in the output said so.
 *
 * The second half of the damage was worse than the message. The pty helper
 * aborts without delivering an exit event, so the session kept reporting
 * `running` for a process that was dead in the first second, and no
 * `<pty_exited>` ever arrived. Anything the model does next - wait, poll, read
 * the size - is then reasoning about a session that does not exist.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A file whose content and mode are both part of the test. */
function fixture(name: string, body: string, mode: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pty-exec-'))
  roots.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, mode)
  return { dir, path }
}

const EXEC = 0o755
const NOEXEC = 0o644

describe('resolveCommand', () => {
  it('resolves a relative path against the workdir, like the kernel will', () => {
    const { dir } = fixture('gen.sh', '#!/bin/sh\nexit 0\n', EXEC)

    expect(resolveCommand('./gen.sh', dir, {})).toBe(join(dir, 'gen.sh'))
  })

  it('does not resolve a bare name against the workdir', () => {
    // A command with no slash in it is a PATH lookup, not a path in the current
    // directory. That is what exec does, and getting it wrong here would invent
    // an executable the shell would never find.
    const { dir } = fixture('gen.sh', '#!/bin/sh\nexit 0\n', EXEC)

    expect(resolveCommand('gen.sh', dir, {})).toBeNull()
    expect(resolveCommand('gen.sh', dir, { PATH: dir })).toBe(join(dir, 'gen.sh'))
  })

  it('leaves an absolute path alone', () => {
    const { path } = fixture('gen.sh', '#!/bin/sh\nexit 0\n', EXEC)

    expect(resolveCommand(path, '/tmp', {})).toBe(path)
  })

  it('finds a bare name on PATH', () => {
    const { dir } = fixture('some-tool', '#!/bin/sh\nexit 0\n', EXEC)

    expect(resolveCommand('some-tool', undefined, { PATH: dir })).toBe(join(dir, 'some-tool'))
  })

  it('honours the PATH the spawn was given, not the process PATH', () => {
    fixture('custom-tool', '#!/bin/sh\nexit 0\n', EXEC)

    // A PATH that does not contain the file must not find it, even though the
    // process PATH may well contain something else by that name.
    expect(resolveCommand('custom-tool', undefined, { PATH: '/nonexistent' })).toBeNull()
  })

  it('returns null for a command it cannot place, rather than guessing', () => {
    expect(resolveCommand('', undefined, {})).toBeNull()
    expect(resolveCommand('not-on-any-path', undefined, { PATH: '/nonexistent' })).toBeNull()
    expect(resolveCommand('no-path-at-all', undefined, {})).toBeNull()
  })
})

describe('checkExecutable', () => {
  it('passes a file that is executable', () => {
    const { dir } = fixture('gen.sh', '#!/usr/bin/env bash\necho hi\n', EXEC)

    expect(checkExecutable('./gen.sh', dir, {}).ok).toBe(true)
  })

  it('rejects a file that exists without the execute bit', () => {
    const { dir, path } = fixture('gen.sh', '#!/usr/bin/env bash\necho hi\n', NOEXEC)

    const result = checkExecutable('./gen.sh', dir, {})

    expect(result.ok).toBe(false)
    // The model has to be able to act on this: which file, and what to run.
    expect(result.ok === false && result.reason).toContain(path)
    expect(result.ok === false && result.reason).toContain('chmod +x ./gen.sh')
  })

  it('names the interpreter the shebang asks for', () => {
    const { dir } = fixture('gen.sh', '#!/usr/bin/env bash\necho hi\n', NOEXEC)

    const result = checkExecutable('./gen.sh', dir, {})

    expect(result.ok === false && result.reason).toContain('bash ./gen.sh')
  })

  it.each([
    ['#!/usr/bin/env python3', 'python3'],
    ['#!/usr/bin/env node', 'node'],
    ['#!/bin/sh', 'sh'],
    ['#!/usr/bin/python3.11', 'python3'],
    ['#!/usr/bin/env -S python3 -u', 'python3'],
    // `fish` ends in the letters `sh`. Substring-matching the shebang answers
    // "sh" here and tells the model to run a fish script with sh, which fails
    // differently and looks authoritative.
    ['#!/usr/bin/env fish', null],
    ['#!/usr/bin/env nu', null],
  ])('reads the interpreter out of %s', (shebang, expected) => {
    const { dir } = fixture('script', `${shebang}\n`, NOEXEC)

    const result = checkExecutable('./script', dir, {})

    if (expected === null) {
      // An unknown interpreter is not guessed at: a wrong guess is a second
      // failure, further from the truth than naming no interpreter at all.
      expect(result.ok === false && result.reason).toContain('whatever runs it')
    } else {
      expect(result.ok === false && result.reason).toContain(`${expected} ./script`)
    }
  })

  it('rejects a non-executable binary found on PATH', () => {
    const { dir } = fixture('tool', '#!/bin/sh\nexit 0\n', NOEXEC)

    const result = checkExecutable('tool', undefined, { PATH: dir })

    expect(result.ok).toBe(false)
  })

  it('passes anything it cannot judge, so a working command is never blocked', () => {
    // Each of these is inconclusive rather than broken. A check that guessed
    // here would block commands that do work.
    const missing = fixture('gone.sh', '#!/bin/sh\n', EXEC)
    rmSync(missing.path)

    expect(checkExecutable('./gone.sh', missing.dir, {}).ok).toBe(true)
    expect(checkExecutable('./nothing-here', '/tmp', {}).ok).toBe(true)
    expect(checkExecutable('not-a-real-binary', undefined, { PATH: '/nonexistent' }).ok).toBe(true)
    expect(checkExecutable('', undefined, {}).ok).toBe(true)
  })

  it('does not judge a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-exec-dir-'))
    roots.push(dir)
    mkdirSync(join(dir, 'subdir'))

    expect(checkExecutable('./subdir', dir, {}).ok).toBe(true)
  })
})

describe('pty_spawn refuses a command it cannot execute', () => {
  const ctx = {
    sessionID: 'parent',
    messageID: 'msg',
    agent: 'agent',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    directory: '/tmp',
    worktree: '/tmp',
  }

  const spawned: string[] = []
  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  it('throws with the fix instead of returning a session that is already dead', async () => {
    // The exact shape that produced the crash dump: a relative path, with a
    // workdir, no execute bit.
    const { dir } = fixture('gen.sh', '#!/usr/bin/env bash\necho should-not-run\n', NOEXEC)

    const spawn = ptySpawn.execute(
      { command: './gen.sh', args: [], description: 'not executable', workdir: dir },
      ctx
    )

    // The decisive property: it throws, so no session exists that could later
    // report itself as running.
    await expect(spawn).rejects.toThrow(/not executable/)
    expect(manager.list().some((s) => s.command === './gen.sh')).toBe(false)
  })

  it('still spawns a command that can be executed', async () => {
    // The other half of the contract: a check that blocks working commands is
    // worse than no check at all.
    const result = await ptySpawn.execute(
      { command: 'bash', args: ['-c', 'sleep 5'], description: 'executable probe' },
      ctx
    )
    const id = (String(result).match(/pty_[0-9a-f]+/) || [])[0]
    if (!id) throw new Error(`no id in spawn result: ${String(result).slice(0, 200)}`)
    spawned.push(id)

    expect(String(result)).toContain(`<pty_spawned id="${id}"`)
  })
})
