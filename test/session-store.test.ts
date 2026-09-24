import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  mergePersistedSessions,
  SessionStore,
  type PersistedSession,
} from '../src/plugin/pty/session-store.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

const roots: string[] = []
const stores: SessionStore[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pty-store-'))
  roots.push(root)
  return root
}

function makeStore(
  options: Partial<ConstructorParameters<typeof SessionStore>[0]> = {}
): SessionStore {
  const store = new SessionStore({
    root: tempRoot(),
    generation: 'gen-test',
    now: () => Date.UTC(2026, 8, 20, 18, 0, 0),
    // A timer that never fires keeps the assertions deterministic; the store is
    // flushed explicitly.
    flushIntervalMs: 1_000_000_000,
    ...options,
  })
  stores.push(store)
  return store
}

function sessionInfo(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_test',
    title: 'Test session',
    description: 'A session',
    command: 'bash',
    args: ['-c', 'echo hi'],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: true,
    timedOut: false,
    pid: 1234,
    createdAt: '2026-09-20T17:00:00.000Z',
    lineCount: 0,
    ...overrides,
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('archives a session and reads its output back', () => {
    const store = makeStore()
    store.startSession({ ...sessionInfo(), parentSessionId: 'ses_parent' })
    store.appendOutput('pty_test', 'line one\nline two\n')
    store.endSession(sessionInfo({ status: 'exited', lineCount: 2 }), 0)

    const entry = store.get('pty_test')
    expect(entry?.status).toBe('exited')
    expect(entry?.exitCode).toBe(0)
    expect(entry?.parentSessionId).toBe('ses_parent')
    expect(entry?.archived).toBe(true)

    const result = store.read('pty_test')
    expect(result?.lines).toEqual(['line one', 'line two'])
    expect(result?.totalLines).toBe(2)
    expect(result?.hasMore).toBe(false)
  })

  it('buffers output until a flush, then keeps it', () => {
    const store = makeStore()
    store.startSession(sessionInfo())

    store.appendOutput('pty_test', 'buffered\n')
    expect(store.read('pty_test')?.lines).toEqual([])

    store.flush()
    expect(store.read('pty_test')?.lines).toEqual(['buffered'])
  })

  it('rotates once at the size cap and keeps the newest output', () => {
    const store = makeStore({ retention: { maxBytesPerSession: 16 } })
    store.startSession(sessionInfo())

    store.appendOutput('pty_test', '1234567890')
    store.flush()
    store.appendOutput('pty_test', 'abcdefghij')
    store.flush()
    store.appendOutput('pty_test', 'KEEP-ME')
    store.flush()

    expect(store.get('pty_test')?.truncated).toBe(true)
    expect(store.readRaw('pty_test')).toContain('KEEP-ME')
  })

  it('searches archived lines with line numbers', () => {
    const store = makeStore()
    store.startSession(sessionInfo())
    store.appendOutput('pty_test', 'alpha\nbeta\nalpha two\n')
    store.flush()

    const result = store.search('pty_test', /alpha/)
    expect(result?.matches).toEqual([
      { lineNumber: 1, text: 'alpha' },
      { lineNumber: 3, text: 'alpha two' },
    ])
    expect(result?.totalMatches).toBe(2)
  })

  it('removes sessions and clears the whole archive', () => {
    const store = makeStore()
    store.startSession(sessionInfo({ id: 'pty_a' }))
    store.startSession(sessionInfo({ id: 'pty_b' }))

    expect(store.remove('pty_a')).toBe(true)
    expect(store.get('pty_a')).toBeNull()
    expect(store.remove('pty_a')).toBe(false)

    expect(store.clear()).toBe(1)
    expect(store.list()).toEqual([])
  })

  it('prunes by age and by count', () => {
    let clock = Date.UTC(2026, 8, 1, 12, 0, 0)
    const store = makeStore({ now: () => clock, retention: { maxSessions: 10, maxAgeDays: 7 } })

    // Finished on Sep 1 ...
    store.startSession(sessionInfo({ id: 'pty_old', createdAt: new Date(clock).toISOString() }))
    store.endSession(sessionInfo({ id: 'pty_old', status: 'exited' }), 0)

    // ... and the next one 19 days later, so the first falls out of retention.
    clock = Date.UTC(2026, 8, 20, 18, 0, 0)
    store.startSession(sessionInfo({ id: 'pty_new', createdAt: new Date(clock).toISOString() }))
    store.endSession(sessionInfo({ id: 'pty_new', status: 'exited' }), 0)

    expect(store.prune()).toEqual(['pty_old'])
    expect(store.list().map((entry) => entry.id)).toEqual(['pty_new'])

    const counting = makeStore({ retention: { maxSessions: 1 } })
    counting.startSession(sessionInfo({ id: 'pty_1', createdAt: '2026-09-19T00:00:00.000Z' }))
    counting.endSession(
      sessionInfo({ id: 'pty_1', status: 'exited', createdAt: '2026-09-19T00:00:00.000Z' }),
      0
    )
    counting.startSession(sessionInfo({ id: 'pty_2', createdAt: '2026-09-20T00:00:00.000Z' }))
    counting.endSession(
      sessionInfo({ id: 'pty_2', status: 'exited', createdAt: '2026-09-20T00:00:00.000Z' }),
      0
    )

    expect(counting.prune()).toEqual(['pty_1'])
  })

  it('marks stale entries as lost when a store is reopened', () => {
    const root = tempRoot()
    const first = makeStore({ root })
    first.startSession({ ...sessionInfo({ id: 'pty_running' }), parentSessionId: 'ses_parent' })
    first.flush()

    const second = makeStore({ root, generation: 'gen-next' })
    const lost = second.markStaleAsLost()

    expect(lost.map((entry) => entry.id)).toEqual(['pty_running'])
    expect(lost[0]?.lost).toBe(true)
    expect(lost[0]?.status).toBe('exited')
    expect(second.get('pty_running')?.parentSessionId).toBe('ses_parent')
  })

  it('tolerates a corrupt index', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'index.json'), '{ not json')

    const store = makeStore({ root })
    expect(store.list()).toEqual([])
  })

  it('does nothing when disabled', () => {
    const root = tempRoot()
    const store = makeStore({ root, enabled: false })

    store.startSession(sessionInfo())
    store.appendOutput('pty_test', 'ignored\n')
    store.flush()

    expect(store.list()).toEqual([])
    expect(store.read('pty_test')).toBeNull()
    expect(existsSync(join(root, 'pty_test'))).toBe(false)
  })
})

describe('mergePersistedSessions', () => {
  const persisted: PersistedSession = {
    ...sessionInfo({
      id: 'pty_archived',
      status: 'exited',
      lineCount: 3,
      parentSessionId: 'ses_parent',
      parentAgent: 'build',
    }),
    archived: true,
    generation: 'gen-1',
    bytes: 42,
    lost: true,
    endedAt: '2026-09-20T17:30:00.000Z',
  }

  it('returns live sessions first and archived ones as read-only history', () => {
    const live = sessionInfo({ id: 'pty_live', status: 'running' })
    const merged = mergePersistedSessions([live], [persisted])

    expect(merged.map((session) => session.id)).toEqual(['pty_live', 'pty_archived'])
    expect(merged[1]?.archived).toBe(true)
    expect(merged[1]?.lost).toBe(true)
    expect(merged[1]?.lineCount).toBe(3)
    expect(merged[1]?.parentSessionId).toBe('ses_parent')
    expect(merged[1]?.parentAgent).toBe('build')
    expect(merged[1]?.endedAt).toBe('2026-09-20T17:30:00.000Z')
  })

  it('lets a live session win over its archived copy', () => {
    const live = sessionInfo({ id: 'pty_archived', status: 'running', lineCount: 99 })
    const merged = mergePersistedSessions([live], [persisted])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.archived).toBeUndefined()
    expect(merged[0]?.lineCount).toBe(99)
  })
})

describe('SessionStore index file', () => {
  it('writes an index that a fresh store can read', () => {
    const root = tempRoot()
    const first = makeStore({ root })
    first.startSession(sessionInfo({ id: 'pty_indexed' }))
    first.flush()

    const raw = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as unknown[]
    expect(raw).toHaveLength(1)

    const second = makeStore({ root })
    expect(second.list().map((entry) => entry.id)).toEqual(['pty_indexed'])
  })
})
