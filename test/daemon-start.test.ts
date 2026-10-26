/**
 * How long a client waits for a daemon it just started.
 *
 * The daemon binds in tens of milliseconds, so the wait is the whole cost of a cold start
 * on the plugin's setup path. These cases pin the schedule that made it short - and the one
 * that matters is the negative one: a fixed quarter-second step would fail it.
 *
 * A real unix socket, not a mock: the answer is what the wait is about, and a file that
 * exists without a listener behind it is exactly the state that must not count.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { socketPollDelay, waitForSocket } from '../src/client/daemon-start.ts'

const dirs: string[] = []

function caseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-pty-start-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('socketPollDelay', () => {
  it('starts tight and settles at the old quarter second', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(socketPollDelay)).toEqual([
      10, 20, 40, 80, 160, 250, 250, 250,
    ])
  })
})

describe('waitForSocket', () => {
  it('returns as soon as a listener answers, well inside the old 250 ms step', async () => {
    const socketPath = join(caseDir(), 'ptyd.sock')
    // Listens a little later, the way a spawning daemon does - but far sooner than the
    // fixed step the old implementation slept through.
    const lateListener = (async () => {
      await Bun.sleep(30)
      return Bun.listen({
        unix: socketPath,
        socket: { data() {}, open() {}, close() {} },
      })
    })()

    const started = performance.now()
    await waitForSocket(socketPath, 5_000)
    const elapsed = performance.now() - started
    const listener = await lateListener
    listener.stop()

    // The old loop slept 250 ms before its first check, so it could not finish this fast.
    expect(elapsed).toBeLessThan(250)
  })

  it('rejects a socket file that nobody listens on, and names where to look', async () => {
    const socketPath = join(caseDir(), 'ptyd.sock')
    // A plain file where the socket should be: what a daemon that lost a race, or one that
    // was killed, leaves behind. Its existence is not an answer.
    await Bun.write(socketPath, 'not a socket')

    const started = performance.now()
    const failure = waitForSocket(socketPath, 300)
    const elapsed = performance.now() - started

    await expect(failure).rejects.toThrow(/did not start/)
    await expect(failure).rejects.toThrow(socketPath)
    // The budget is a deadline, not a step count: 300 ms means about 300 ms.
    expect(elapsed).toBeLessThan(1_500)
  })
})
