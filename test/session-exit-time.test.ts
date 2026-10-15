import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { ManagedTestServer } from './utils.ts'

/**
 * When a process stopped.
 *
 * The buffer keeps what a process printed but nothing recorded when it printed
 * it, so "this run took four minutes" had to be answered by watching a clock.
 * The archive had the same gap, and worse: `endedAt` is written from the exit
 * notification, which a restart loses - and a transcript that outlives its
 * process is exactly the one whose duration you want.
 */

/** Poll until `check` yields a value, or give up. Keeps the test free of fixed sleeps. */
async function waitFor<T>(check: () => T | undefined, ms = 4000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  let value = check()
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = check()
  }
  return value
}

describe('session exit time', () => {
  const stack = new DisposableStack()

  beforeAll(async () => {
    stack.use(await ManagedTestServer.create())
  })

  afterAll(() => {
    stack.dispose()
    manager.clearAllSessions()
  })

  async function spawn(command: string, args: string[]) {
    const title = `exit-time-${crypto.randomUUID()}`
    await ptySpawn.execute(
      { command, args, title, description: 'exit-time test' },
      {
        sessionID: 'test-parent-session',
        messageID: 'msg-1',
        agent: 'test-agent',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
        directory: '/tmp',
        worktree: '/tmp',
      }
    )
    const info = await waitFor(() => manager.list().find((s) => s.title === title))
    if (!info) throw new Error('session was never registered')
    return info
  }

  it('leaves the end unset while the process runs', async () => {
    const running = await spawn('sleep', ['30'])
    try {
      expect(running.status).toBe('running')
      // A running process has no end yet - the reader measures to "now" instead.
      expect(running.exitAt).toBeUndefined()
    } finally {
      manager.kill(running.id, true)
    }
  })

  it('records the exit time, and carries it into the archive', async () => {
    const started = await spawn('true', [])
    const exited = await waitFor(() => {
      const session = manager.get(started.id)
      return session && session.status !== 'running' && session.status !== 'killing'
        ? session
        : undefined
    })
    expect(exited?.status).toBe('exited')

    const createdAt = exited?.createdAt
    const exitAt = exited?.exitAt
    if (!createdAt || !exitAt) throw new Error('expected both timestamps on a finished session')
    expect(Date.parse(exitAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))

    // The archive is the point: a transcript that outlives its process is
    // exactly the one whose duration cannot be stated any other way.
    const archived = manager.getSessionStore().get(started.id)
    if (!archived) throw new Error('the finished session was not archived')
    expect(archived.exitAt).toBe(exitAt)
  })

  it('records the exit time of a killed session, which keeps its record', async () => {
    // A kill without cleanup keeps the archive, so the run has a duration. The
    // Remove path (kill with cleanup) does not: manager.kill drops the archive
    // after the exit handler has run, and nothing puts it back. Measured, not
    // assumed - that asymmetry is why the row has to say so.
    const running = await spawn('sleep', ['30'])
    manager.kill(running.id, false)

    const archived = await waitFor(() => {
      const entry = manager.getSessionStore().get(running.id)
      return entry && entry.status !== 'running' && entry.status !== 'killing' ? entry : undefined
    })
    if (!archived) throw new Error('a killed session was never archived')
    if (!archived.exitAt) throw new Error('a killed session has no exit time')
    expect(Number.isFinite(Date.parse(archived.exitAt))).toBe(true)
  })

  it('leaves no exit time behind after Remove, because Remove keeps no record', async () => {
    const running = await spawn('sleep', ['30'])
    manager.kill(running.id, true)

    // Wait past the point where an exit would have been archived.
    await Bun.sleep(1200)
    const entry = manager.getSessionStore().get(running.id)
    // Not "no exit time on a record" - no record at all, which is the honest
    // answer: a removed session cannot report how long it ran, because there is
    // nothing left to report from.
    expect(entry === null || entry.exitAt === undefined).toBe(true)
  })
})
