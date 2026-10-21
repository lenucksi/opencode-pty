import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyTrash,
  listTrash,
  moveToTrash,
  removeArchive,
  restoreFromTrash,
} from '../src/plugin/pty/archive-trash.ts'
import { META_FILE, TRASH_DIR } from '../src/plugin/pty/archive-files.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'archive-trash-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function session(root: string, id: string, meta: Record<string, unknown> = {}): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, META_FILE), JSON.stringify({ id, title: id, ...meta }))
}

describe('moveToTrash', () => {
  it('renames the session into the trash directory', () => {
    const root = tempRoot()
    session(root, 'pty_a')
    expect(moveToTrash(root, 'pty_a')).toBe(true)
    expect(existsSync(join(root, 'pty_a'))).toBe(false)
    expect(existsSync(join(root, TRASH_DIR, 'pty_a'))).toBe(true)
  })

  it('returns false for a source that is already gone, without logging', () => {
    // The regression this pins: a stale index lists ids whose directory was
    // removed, and the old implementation logged one ENOENT per entry - a wall of
    // noise at every daemon start, for a condition that is the documented contract.
    const root = tempRoot()
    expect(moveToTrash(root, 'pty_missing')).toBe(false)
    expect(existsSync(join(root, TRASH_DIR, 'pty_missing'))).toBe(false)
  })
})

describe('restoreFromTrash', () => {
  it('brings a session back with its metadata', () => {
    const root = tempRoot()
    session(root, 'pty_b', { title: 'restore me' })
    moveToTrash(root, 'pty_b')
    const restored = restoreFromTrash(root, 'pty_b')
    expect(restored?.title).toBe('restore me')
    expect(existsSync(join(root, 'pty_b'))).toBe(true)
  })

  it('returns null when the trash entry has no metadata file', () => {
    const root = tempRoot()
    mkdirSync(join(root, TRASH_DIR, 'pty_meta'), { recursive: true })
    expect(restoreFromTrash(root, 'pty_meta')).toBeNull()
  })

  it('returns null for an id that is not in the trash', () => {
    expect(restoreFromTrash(tempRoot(), 'pty_none')).toBeNull()
  })

  it('refuses to overwrite a live directory', () => {
    const root = tempRoot()
    session(root, 'pty_live')
    mkdirSync(join(root, TRASH_DIR, 'pty_live'), { recursive: true })
    writeFileSync(join(root, TRASH_DIR, 'pty_live', META_FILE), JSON.stringify({ id: 'pty_live' }))
    expect(restoreFromTrash(root, 'pty_live')).toBeNull()
  })
})

describe('trash listing and emptying', () => {
  it('lists what is in the trash and empties it', () => {
    const root = tempRoot()
    session(root, 'pty_c')
    session(root, 'pty_d')
    moveToTrash(root, 'pty_c')
    moveToTrash(root, 'pty_d')
    expect(listTrash(root).sort()).toEqual(['pty_c', 'pty_d'])
    expect(emptyTrash(root)).toBe(2)
    expect(listTrash(root)).toEqual([])
  })

  it('reports nothing to list or empty when there is no trash', () => {
    const root = tempRoot()
    expect(listTrash(root)).toEqual([])
    expect(emptyTrash(root)).toBe(0)
  })
})

describe('removeArchive', () => {
  it('removes a session directly when no trash is wanted', () => {
    const root = tempRoot()
    session(root, 'pty_e')
    expect(removeArchive(root, 'pty_e')).toBe(true)
    expect(existsSync(join(root, 'pty_e'))).toBe(false)
  })

  it('is idempotent: removing an id that is already gone still succeeds', () => {
    // rmSync with `force` is the contract here: purge is called on ids the index
    // already dropped, and a missing directory is not a failure.
    expect(removeArchive(tempRoot(), 'pty_missing')).toBe(true)
  })
})
