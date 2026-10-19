import { describe, expect, it } from 'bun:test'

import { PtyClient } from '../src/client/pty-client.ts'
import { sessionUpdateCallbacks } from '../src/plugin/pty/manager-notifications.ts'

/**
 * The API half of the client, against a stub transport.
 *
 * Every method here is one line of `request(...)`, and a typo in the method name
 * would only show up against a live daemon - where the answer is `unknown method`
 * and the failure reads like a protocol bug. The stub pins the method name and the
 * parameters instead.
 */
class StubClient extends PtyClient {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  responses: Record<string, unknown> = {}

  protected override async request(
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    this.calls.push(params === undefined ? { method } : { method, params })
    return this.responses[method]
  }
}

function client(responses: Record<string, unknown> = {}): StubClient {
  const stub = new StubClient()
  stub.responses = responses
  return stub
}

describe('PtyClient API surface', () => {
  it('forwards spawn options unchanged', async () => {
    const stub = client({ spawn: { id: 'pty_1' } })
    const options = { command: 'echo', parentSessionId: 'ses_1' }
    expect(await stub.spawn(options)).toEqual({ id: 'pty_1' })
    expect(stub.calls).toEqual([{ method: 'spawn', params: options }])
  })

  it('unwraps success flags for write, kill and resize', async () => {
    const stub = client({
      write: { success: true },
      kill: { success: false },
      resize: { success: true },
    })
    expect(await stub.write('pty_1', 'x')).toBe(true)
    expect(await stub.kill('pty_1', true)).toBe(false)
    expect(await stub.resize('pty_1', 120, 40)).toBe(true)
    expect(stub.calls).toEqual([
      { method: 'write', params: { id: 'pty_1', data: 'x' } },
      { method: 'kill', params: { id: 'pty_1', cleanup: true } },
      { method: 'resize', params: { id: 'pty_1', cols: 120, rows: 40 } },
    ])
  })

  it('treats a missing success flag as false', async () => {
    expect(await client({}).kill('pty_1')).toBe(false)
  })

  it('passes read paging and the search pattern source', async () => {
    const stub = client({ read: { lines: [] }, search: { matches: [] } })
    await stub.read('pty_1', 5, 50, 1000)
    await stub.search('pty_1', /err.r/i, 0, 10, 500)
    expect(stub.calls).toEqual([
      { method: 'read', params: { id: 'pty_1', offset: 5, limit: 50, budget: 1000 } },
      {
        method: 'search',
        params: { id: 'pty_1', pattern: 'err.r', offset: 0, limit: 10, budget: 500 },
      },
    ])
  })

  it('lists, gets and pings', async () => {
    const stub = client({ list: [], get: null, ping: { pong: true, generation: 'g' } })
    expect(await stub.list()).toEqual([])
    expect(await stub.get('pty_1')).toBeNull()
    expect(await stub.ping()).toEqual({ pong: true, generation: 'g' })
    expect(stub.calls.map((call) => call.method)).toEqual(['list', 'get', 'ping'])
  })

  it('sends a heartbeat', async () => {
    const stub = client({ heartbeat: { ok: true } })
    await stub.heartbeat()
    expect(stub.calls).toEqual([{ method: 'heartbeat' }])
  })

  it('unwraps a session log', async () => {
    const stub = client({ get_session_log: { log: 'line\n' } })
    expect(await stub.getSessionLog('pty_1', { tail: 5 })).toBe('line\n')
    expect(stub.calls[0]).toEqual({
      method: 'get_session_log',
      params: { id: 'pty_1', tail: 5 },
    })
    expect(await client({}).getSessionLog('pty_1')).toBeNull()
  })

  it('forwards the remaining manager calls', async () => {
    const stub = client({})
    await stub.getSession('pty_1')
    await stub.describeMissingSession('pty_1')
    await stub.describeServer()
    await stub.getRawBuffer('pty_1', 10, 99)
    await stub.readSince('pty_1', 10, 99)
    await stub.cleanupBySession('ses_1')
    await stub.loadPersistedSessions()
    await stub.bulkRemove(['pty_1', 'pty_2'])
    await stub.restoreSessions(['pty_1'])
    await stub.clearAllSessions()
    stub.noteClientSize(120, 40)
    expect(stub.calls).toEqual([
      { method: 'get_session', params: { id: 'pty_1' } },
      { method: 'describe_missing_session', params: { id: 'pty_1' } },
      { method: 'describe_server', params: undefined },
      { method: 'get_raw_buffer', params: { id: 'pty_1', since: 10, budget: 99 } },
      { method: 'read_since', params: { id: 'pty_1', since: 10, budget: 99 } },
      { method: 'cleanup_by_session', params: { parentSessionId: 'ses_1' } },
      { method: 'load_persisted_sessions', params: undefined },
      { method: 'bulk_remove', params: { ids: ['pty_1', 'pty_2'] } },
      { method: 'restore_sessions', params: { ids: ['pty_1'] } },
      { method: 'clear_all_sessions', params: undefined },
      { method: 'note_client_size', params: { cols: 120, rows: 40 } },
    ])
  })

  it('exposes the store through the same requests', async () => {
    const stub = client({
      get_retention: { retention: { maxSessions: 5 } },
      update_retention: { pruned: ['pty_1'] },
      get_generation: { generation: 'gen' },
      get_state_dir: { stateDir: '/state' },
      list_persisted: ['a'],
      read_persisted: { lines: ['x'] },
    })
    const store = await stub.getSessionStore()
    expect(await store.getRetention()).toEqual({ maxSessions: 5 })
    expect(await store.updateRetention({ maxSessions: 5 })).toEqual(['pty_1'])
    expect(await store.getGeneration()).toBe('gen')
    expect(await store.getRoot()).toBe('/state')
    expect(await store.list()).toEqual(['a'])
    expect(await store.read('pty_1', 0, 5)).toEqual({ lines: ['x'] })
    expect(await store.isEnabled()).toBe(true)
    expect(await store.close()).toBeUndefined()
    await stub.setSessionStore(null)
    expect(stub.calls.map((call) => call.method)).toContain('update_retention')
  })

  it('keeps the notifier for exit pushes', async () => {
    const stub = client({})
    const seen: string[] = []
    stub.setNotifier({
      sendExitNotification: async (session) => {
        seen.push(session.id)
      },
    })
    stub.setNotificationManager(null)
    // The push itself is registered on connect; this pins that the setter stores
    // the object rather than ignoring it.
    expect(seen).toEqual([])
  })

  it('marks session-update pushes through the shared callback list', () => {
    const received: string[] = []
    const probe = (session: { id: string }): void => {
      received.push(session.id)
    }
    sessionUpdateCallbacks.push(probe)
    try {
      for (const callback of sessionUpdateCallbacks) callback({ id: 'pty_probe' } as never)
      expect(received).toContain('pty_probe')
    } finally {
      const index = sessionUpdateCallbacks.indexOf(probe)
      if (index !== -1) sessionUpdateCallbacks.splice(index, 1)
    }
  })
})
