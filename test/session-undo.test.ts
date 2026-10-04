import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore, type PersistSessionInput } from '../src/plugin/pty/session-store.ts'

/**
 * Removing a session has to be reversible.
 *
 * The buffer is the only record of what a process printed. A human who removes
 * the wrong five out of two hundred has no other way back, and that buffer is
 * what a bug report is written from. So `remove` moves to `.trash` instead of
 * deleting, and `restore` puts it back.
 *
 * The window is bounded on purpose: `purgeTrash` runs before anything else at
 * startup, so a trash entry never outlives the process that could restore it. An
 * undo that silently survives a restart promises more than it keeps.
 *
 * `purge` and `clear` are the deliberate exception. "Clear everything" that can
 * be undone is not a clear.
 */

const roots: string[] = []

function makeStore(): { root: string; store: SessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'pty-store-undo-'))
  roots.push(root)
  return { root, store: new SessionStore({ root }) }
}

function sessionInfo(
  id: string,
  overrides: Partial<PersistSessionInput> = {}
): PersistSessionInput {
  // Object.assign rather than a spread: spreading `Partial` over the literal
  // widens every overridden field back to `T | undefined`, which is not
  // assignable to a type where those fields are required.
  return Object.assign(
    {
      id,
      title: `session ${id}`,
      command: 'bash',
      args: [],
      status: 'exited',
      notifyOnExit: false,
      timedOut: false,
      pid: 4242,
      exitCode: 0,
      lineCount: 1,
      charCount: 12,
      cols: 80,
      rows: 24,
      workdir: '/tmp',
      createdAt: '2026-10-04T00:00:00.000Z',
      endedAt: '2026-10-04T00:00:01.000Z',
    },
    overrides
  )
}

/** Archive a finished session with one line of output. */
function archive(store: SessionStore, id: string, line = 'hello'): void {
  store.startSession(sessionInfo(id))
  store.appendOutput(id, `${line}\n`)
  store.endSession(sessionInfo(id), 0)
  store.flush()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('removing a session is reversible', () => {
  let root: string
  let store: SessionStore

  beforeEach(() => {
    ;({ root, store } = makeStore())
  })

  it('takes the directory out of the session root', () => {
    archive(store, 'pty_aaaaaaaa')
    expect(existsSync(join(root, 'pty_aaaaaaaa'))).toBe(true)

    expect(store.remove('pty_aaaaaaaa')).toBe(true)

    // Gone from where the list looks, which is what "removed" has to mean.
    expect(existsSync(join(root, 'pty_aaaaaaaa'))).toBe(false)
    expect(store.list().some((entry) => entry.id === 'pty_aaaaaaaa')).toBe(false)
  })

  it('keeps the directory, and the output in it, in the trash', () => {
    archive(store, 'pty_aaaaaaaa', 'the only record of what the process printed')
    store.remove('pty_aaaaaaaa')

    expect(existsSync(join(root, '.trash', 'pty_aaaaaaaa', 'output.log'))).toBe(true)
    expect(store.trashed()).toEqual(['pty_aaaaaaaa'])
  })

  it('puts the session and its output back', () => {
    archive(store, 'pty_aaaaaaaa', 'the only record of what the process printed')
    store.remove('pty_aaaaaaaa')

    expect(store.restore('pty_aaaaaaaa')).toBe(true)

    expect(existsSync(join(root, 'pty_aaaaaaaa', 'output.log'))).toBe(true)
    expect(store.readRaw('pty_aaaaaaaa')).toContain('the only record')
  })

  it('rejoins the index on restore, so it reappears in the list', () => {
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')
    expect(store.list()).toHaveLength(0)

    store.restore('pty_aaaaaaaa')

    // Without this the session comes back on disk and stays invisible, which is
    // worse than not restoring it: the human believes it is gone and it is not.
    expect(store.list().map((entry) => entry.id)).toContain('pty_aaaaaaaa')
  })

  it('restores a session that never left the index alone', () => {
    // A directory with output but no index entry: restoring it must not throw,
    // and must not invent an index entry it has no metadata for.
    store.startSession(sessionInfo('pty_bbbbbbbb'))
    store.flush()
    store.purge('pty_bbbbbbbb')

    expect(store.restore('pty_bbbbbbbb')).toBe(false)
  })

  it('reports an unknown id instead of throwing', () => {
    expect(store.restore('pty_ffffffff')).toBe(false)
    expect(store.remove('pty_ffffffff')).toBe(false)
  })

  it('never lists a trashed session as restorable twice', () => {
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')

    store.restore('pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')

    expect(store.trashed()).toEqual(['pty_aaaaaaaa'])
  })

  it('empties the trash on demand', () => {
    archive(store, 'pty_aaaaaaaa')
    archive(store, 'pty_bbbbbbbb')
    store.remove('pty_aaaaaaaa')
    store.remove('pty_bbbbbbbb')

    expect(store.purgeTrash()).toBe(2)
    expect(store.trashed()).toEqual([])
  })

  it('empties the trash before anything can fill it again', () => {
    // A trash entry must not survive the process that could have restored it. The
    // window is "until restart", and this is what makes that true.
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')
    expect(store.trashed()).toHaveLength(1)

    const reopened = new SessionStore({ root })

    expect(reopened.trashed()).toEqual([])
    expect(existsSync(join(root, '.trash'))).toBe(false)
  })

  it('does not mistake the trash for a session directory', () => {
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')

    // The index is read from `index.json`, not from scanning the directory, so a
    // `.trash` entry cannot surface as a session in the list.
    expect(store.list().some((entry) => entry.id.startsWith('.trash'))).toBe(false)
    expect(readdirSync(root).filter((entry) => entry === 'pty_aaaaaaaa')).toEqual([])
  })

  it('disables everything when the store is disabled', () => {
    const disabled = new SessionStore({ root: join(root, 'off'), enabled: false })

    expect(disabled.remove('pty_aaaaaaaa')).toBe(false)
    expect(disabled.restore('pty_aaaaaaaa')).toBe(false)
    expect(disabled.trashed()).toEqual([])
    expect(disabled.purgeTrash()).toBe(0)
  })
})

describe('purge and clear are not undoable, and say so by doing it', () => {
  let root: string
  let store: SessionStore

  beforeEach(() => {
    ;({ root, store } = makeStore())
  })

  it('purge leaves nothing to restore', () => {
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')
    store.restore('pty_aaaaaaaa')

    expect(store.purge('pty_aaaaaaaa')).toBe(true)

    expect(existsSync(join(root, 'pty_aaaaaaaa'))).toBe(false)
    expect(store.restore('pty_aaaaaaaa')).toBe(false)
    expect(store.trashed()).toEqual([])
  })

  it('clear removes every session and leaves no trash', () => {
    archive(store, 'pty_aaaaaaaa')
    archive(store, 'pty_bbbbbbbb')
    archive(store, 'pty_cccccccc')

    expect(store.clear()).toBe(3)

    expect(store.list()).toHaveLength(0)
    expect(store.trashed()).toEqual([])
    expect(existsSync(join(root, 'pty_aaaaaaaa'))).toBe(false)
  })

  it('does not make a previously removed session restorable through clear', () => {
    archive(store, 'pty_aaaaaaaa')
    store.remove('pty_aaaaaaaa')
    archive(store, 'pty_bbbbbbbb')

    store.clear()

    expect(store.restore('pty_aaaaaaaa')).toBe(false)
  })
})
