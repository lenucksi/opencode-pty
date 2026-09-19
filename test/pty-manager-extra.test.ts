import { afterAll, describe, expect, it } from 'bun:test'
import {
  manager,
  registerRawOutputCallback,
  registerSessionUpdateCallback,
  removeRawOutputCallback,
  removeSessionUpdateCallback,
  setManagerNotifier,
} from '../src/plugin/pty/manager.ts'
import { NotificationManager } from '../src/plugin/pty/notification-manager.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

async function waitForOutput(sessionId: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = manager.read(sessionId)
    if (result && result.totalLines > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for output from ${sessionId}`)
}

describe('PTYManager extra behaviour', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) {
      manager.kill(id, true)
    }
    manager.clearAllSessions()
    setManagerNotifier(null)
  })

  it('reads, searches and snapshots a live session buffer', async () => {
    const session = manager.spawn({
      command: 'echo',
      args: ['hello searchable world'],
      description: 'manager search',
      parentSessionId: 'manager-parent',
    })
    spawned.push(session.id)

    await waitForOutput(session.id)

    const read = manager.read(session.id)
    expect(read?.lines.join('\n')).toContain('searchable')

    const search = manager.search(session.id, /searchable/)
    expect(search?.matches).toHaveLength(1)
    expect(search?.matches[0]?.text).toContain('searchable')

    const raw = manager.getRawBuffer(session.id)
    expect(raw?.raw).toContain('searchable')
    expect(raw?.byteLength).toBe(new TextEncoder().encode(raw?.raw ?? '').length)

    const since = manager.getRawBuffer(session.id, 5)
    expect(since?.offset).toBe(5)
    expect(since?.raw).toBe((raw?.raw ?? '').slice(5))
  })

  it('returns null for unknown sessions', () => {
    expect(manager.read('pty_nope')).toBeNull()
    expect(manager.search('pty_nope', /x/)).toBeNull()
    expect(manager.getRawBuffer('pty_nope')).toBeNull()
    expect(manager.get('pty_nope')).toBeNull()
  })

  it('cleans up sessions by parent session id', async () => {
    const parent = `parent-${crypto.randomUUID()}`
    const session = manager.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'cleanup by parent',
      parentSessionId: parent,
    })
    expect(manager.get(session.id)).not.toBeNull()

    manager.cleanupBySession(parent)

    expect(manager.get(session.id)).toBeNull()
  })

  it('defaults to the built-in NotificationManager notifier', () => {
    setManagerNotifier(null)
    expect(manager.getNotifier()).toBeInstanceOf(NotificationManager)
  })

  it('swallows errors thrown by registered callbacks', () => {
    const throwingUpdate = (_session: PTYSessionInfo) => {
      throw new Error('update callback failed')
    }
    const throwingRaw = () => {
      throw new Error('raw callback failed')
    }
    registerSessionUpdateCallback(throwingUpdate)
    registerRawOutputCallback(throwingRaw)

    try {
      expect(() =>
        manager.spawn({
          command: 'echo',
          args: ['callback tolerance'],
          description: 'callback tolerance',
          parentSessionId: 'callback-parent',
        })
      ).not.toThrow()
    } finally {
      removeSessionUpdateCallback(throwingUpdate)
      removeRawOutputCallback(throwingRaw)
    }

    manager.clearAllSessions()
  })
})
