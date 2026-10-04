import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import type { BunRequest } from 'bun'

import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { createApiClient } from '../src/web/shared/api-client.ts'
import { routes } from '../src/web/shared/routes.ts'
import { bulkRemoveSessions, restoreSessions } from '../src/web/server/handlers/sessions.ts'
import { ManagedTestServer } from './utils.ts'

/**
 * Removing many sessions at once.
 *
 * Two kinds of target hide behind one button, and only one of them can be taken
 * back. An archived session is a directory; moving it to the trash is reversible.
 * A running session is a process with its buffer in memory, and killing it with
 * `cleanup` clears that buffer without ever writing an archive - so there is
 * nothing left to move.
 *
 * The server therefore reports which ids were `removed` and which were `killed`
 * instead of a total. A total cannot tell the web UI what it has to warn about
 * before the call, and a bulk action that cannot say what it destroys is the one
 * people run twice.
 */

let managedTestServer: ManagedTestServer
let disposableStack: DisposableStack

beforeAll(async () => {
  disposableStack = new DisposableStack()
  managedTestServer = await ManagedTestServer.create()
  disposableStack.use(managedTestServer)
})

afterAll(() => {
  manager.clearAllSessions()
  disposableStack.dispose()
})

afterEach(() => {
  // Spies on the manager are per-test; a leaked one would make the real
  // removal tests below pass against a mocked manager.
  mock.restore()
})

/** Spawn a real process and return its id, read from the result tag. */
async function spawnId(command: string, args: string[]): Promise<string> {
  const result = await ptySpawn.execute(
    {
      command,
      args,
      title: `bulk-${crypto.randomUUID()}`,
      description: 'bulk removal test',
    },
    {
      sessionID: 'bulk-removal-test',
      messageID: 'msg-1',
      agent: 'test-agent',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      directory: '/tmp',
      worktree: '/tmp',
    }
  )
  const output = typeof result === 'string' ? result : result.output
  const id = /<pty_spawned id="([^"]+)"/.exec(output)?.[1]
  if (!id) throw new Error(`spawn returned no id: ${output.slice(0, 200)}`)
  return id
}

/** A session that has ended and been archived. */
async function spawnFinished(): Promise<string> {
  const id = await spawnId('echo', ['finished'])
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const session = manager.get(id)
    if (session && session.status !== 'running' && session.status !== 'killing') return id
    await Bun.sleep(25)
  }
  throw new Error(`session ${id} never left running`)
}

/** Whether this id still shows up in the list the web UI renders. */
function listed(id: string): boolean {
  return manager.list().some((session) => session.id === id)
}

/** A session that is still running. */
async function spawnRunning(): Promise<string> {
  return spawnId('sleep', ['41'])
}

describe('bulk removal keeps the two kinds of target apart', () => {
  it('removes a finished session to the trash', async () => {
    const id = await spawnFinished()

    const result = manager.bulkRemove([id])

    expect(result.removed).toContain(id)
    expect(result.killed).not.toContain(id)
    // The row has to disappear, not merely lose its archive. A finished session
    // is still in the lifecycle map, and `list()` merges that map with the
    // archive - so clearing only the archive leaves an item on screen that no
    // longer has a buffer behind it.
    expect(listed(id)).toBe(false)
    expect(manager.get(id)).toBeNull()
  })

  it('puts a removed session back, output included', async () => {
    const id = await spawnFinished()
    manager.bulkRemove([id])

    const result = manager.restoreSessions([id])

    expect(result.restored).toContain(id)
    // Without the index entry it would be on disk and invisible, which is worse
    // than not restoring it: the human believes it is gone and it is not.
    expect(listed(id)).toBe(true)
  })

  it('stops a running session and says it was stopped, not removed', async () => {
    const id = await spawnRunning()

    expect(listed(id)).toBe(true)

    const removed = manager.bulkRemove([id])

    // The distinction the web UI warns with: a running process is killed.
    expect(removed.killed).toContain(id)
    expect(removed.removed).not.toContain(id)
    expect(listed(id)).toBe(false)
  })

  it('brings a killed session back as a row, with an empty buffer', async () => {
    // Measured, and the reason this is not written as "cannot be restored": the
    // archive directory is created at spawn, so a session killed with cleanup
    // has one. `kill` clears the in-memory buffer and never flushes it, so what
    // comes back is the session record without its output.
    //
    // A row that reappears empty is better than no row - the human can see that
    // something ran and that its output is gone - and it is only honest because
    // the UI says the killed count separately from the restored count.
    const id = await spawnRunning()
    manager.bulkRemove([id])

    expect(manager.restoreSessions([id])).toEqual({ restored: [id], failed: [] })
    expect(listed(id)).toBe(true)
  })

  it('reports an id that matches nothing as failed, without touching the rest', async () => {
    const id = await spawnFinished()

    const result = manager.bulkRemove([id, 'pty_deadbeef'])

    expect(result.removed).toContain(id)
    expect(result.failed).toEqual(['pty_deadbeef'])
  })

  it('splits a mixed selection into its two kinds', async () => {
    const finished = await spawnFinished()
    const running = await spawnRunning()

    const result = manager.bulkRemove([finished, running])

    expect(result.removed).toEqual([finished])
    expect(result.killed).toEqual([running])
  })

  it('removes nothing and changes nothing for an empty selection', async () => {
    const id = await spawnFinished()

    const result = manager.bulkRemove([])

    expect(result).toEqual({ removed: [], killed: [], failed: [] })
    expect(listed(id)).toBe(true)
  })
})

describe('a removal request is rejected rather than guessed at', () => {
  function request(body: unknown) {
    return { json: async () => body } as unknown as BunRequest<typeof routes.sessions.bulk.path>
  }

  it('needs a body', async () => {
    const spy = spyOn(manager, 'bulkRemove')

    const response = await bulkRemoveSessions({
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as BunRequest<typeof routes.sessions.bulk.path>)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('array of session ids')
    expect(spy).not.toHaveBeenCalled()
  })

  it('needs an ids array', async () => {
    const response = await bulkRemoveSessions(request({ nope: true }))
    expect(response.status).toBe(400)
  })

  it('rejects ids that are not strings instead of dropping them', async () => {
    const spy = spyOn(manager, 'bulkRemove')

    // Silently removing the two that parsed out of three would report success
    // and leave a session the human believed was gone.
    const response = await bulkRemoveSessions(request({ ids: ['pty_1', 7, 'pty_2'] }))

    expect(response.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an empty id, which would address no session at all', async () => {
    const response = await bulkRemoveSessions(request({ ids: ['pty_1', ''] }))
    expect(response.status).toBe(400)
  })

  it('rejects a selection of nothing rather than answering success', async () => {
    const response = await bulkRemoveSessions(request({ ids: [] }))

    // A removal of nothing is a client bug, and 200 would hide it.
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('No session ids')
  })

  it('hands the ids on and returns the split', async () => {
    const spy = spyOn(manager, 'bulkRemove').mockReturnValue({
      removed: ['pty_1'],
      killed: ['pty_2'],
      failed: [],
    })

    const response = await bulkRemoveSessions(request({ ids: ['pty_1', 'pty_2'] }))

    expect(spy).toHaveBeenCalledWith(['pty_1', 'pty_2'])
    expect(await response.json()).toEqual({
      removed: ['pty_1'],
      killed: ['pty_2'],
      failed: [],
    })
  })

  it('validates a restore the same way', async () => {
    const response = await restoreSessions(
      request({ ids: [] }) as unknown as BunRequest<typeof routes.sessions.restore.path>
    )
    expect(response.status).toBe(400)
  })
})

describe('the collection routes are not shadowed by the :id route', () => {
  function url(path: string): string {
    return new URL(path, managedTestServer.server.server.url).toString()
  }

  it('reaches the bulk handler', async () => {
    // 400 and not 404: `:id` declares GET and DELETE only, so if Bun matched the
    // parameter before the static segment this would answer 405.
    const response = await fetch(url(routes.sessions.bulk.path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })

    expect(response.status).toBe(400)
  })

  it('reaches the restore handler', async () => {
    const response = await fetch(url(routes.sessions.restore.path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })

    expect(response.status).toBe(400)
  })

  it('leaves the single-session route working', async () => {
    const response = await fetch(url('/api/sessions/pty_does_not_exist'), { method: 'DELETE' })
    expect(response.status).toBe(400)
  })

  it('leaves the remove-everything route untouched', async () => {
    // `DELETE /api/sessions` with no body is still the nuke the tests and the
    // E2E fixtures rely on to start from a clean slate.
    const response = await fetch(url(routes.sessions.path), { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
  })
})

describe('the api client speaks to the new routes', () => {
  it('removes a selection in one request and returns the split', async () => {
    const client = createApiClient(managedTestServer.server.server.url.toString())
    const finished = await spawnFinished()
    const running = await spawnRunning()

    const result = await client.sessions.bulkRemove({ ids: [finished, running, 'pty_nope'] })

    expect(result.removed).toEqual([finished])
    expect(result.killed).toEqual([running])
    expect(result.failed).toEqual(['pty_nope'])
  })

  it('restores what a removal reported as removed', async () => {
    const client = createApiClient(managedTestServer.server.server.url.toString())
    const finished = await spawnFinished()
    await client.sessions.bulkRemove({ ids: [finished] })

    const result = await client.sessions.restore({ ids: [finished] })

    expect(result.restored).toEqual([finished])
    expect(listed(finished)).toBe(true)
  })

  it('reports a restore of something that was never removed as failed', async () => {
    const client = createApiClient(managedTestServer.server.server.url.toString())

    const result = await client.sessions.restore({ ids: ['pty_never_existed'] })

    // The one case restore must refuse: nothing was removed, so nothing comes
    // back. A restore that reports success and changes nothing is the failure
    // mode an undo must not have.
    expect(result.restored).toEqual([])
    expect(result.failed).toEqual(['pty_never_existed'])
  })
})
