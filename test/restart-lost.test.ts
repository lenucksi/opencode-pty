/**
 * A client connecting must not kill the sessions the daemon is running.
 *
 * This is the bug behind the false `<pty_restart>` on 2026-11-18 and 2026-11-23:
 * `load_persisted_sessions` called `markStaleAsLost()` on the daemon's live store, and
 * the plugin calls that RPC at EVERY setup - one per opencode server restart, one per
 * project. A second client therefore marked still-running sessions "lost" in the archive
 * and the restart notice told the agent to start them again, which failed with
 * "port in use" because the originals never died.
 *
 * The test goes through the real socket: a fresh isolated daemon, a real session, then
 * a second client doing what the plugin setup does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'

const stamp = Date.now()
const socketPath = `/tmp/opencode-pty-restart-${stamp}.sock`
const stateDir = `/tmp/opencode-pty-restart-state-${stamp}`
let daemonProc: ReturnType<typeof Bun.spawn>

describe('a second client must not mark live sessions lost', () => {
  beforeAll(async () => {
    mkdirSync(stateDir, { recursive: true })
    daemonProc = Bun.spawn(
      ['bun', 'run', 'src/daemon/index.ts', '--socket', socketPath, '--state-dir', stateDir],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    for (let i = 0; i < 40; i += 1) {
      await Bun.sleep(250)
      if (existsSync(socketPath)) break
    }
    expect(existsSync(socketPath)).toBe(true)
  })

  afterAll(async () => {
    const pidFile = `${socketPath.slice(0, socketPath.lastIndexOf('/'))}/ptyd.pid`
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    } catch {
      // No pid file, or already gone.
    }
    try {
      daemonProc.kill()
    } catch {}
    await Bun.sleep(200)
    try {
      rmSync(socketPath)
    } catch {}
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {}
  })

  it('leaves a running session running across a plugin-style reconnect', async () => {
    const owner = new PtyClient({ socketPath, stateDir })
    await owner.connect()
    const session = await owner.spawn({
      command: 'bash',
      args: ['-lc', 'sleep 30'],
      description: 'still running',
      notifyOnExit: false,
    })
    expect(session.status).toBe('running')

    // What src/v2/index.ts does at the setup of every new plugin instance.
    const newcomer = new PtyClient({ socketPath, stateDir })
    await newcomer.connect()
    const restored = await newcomer.loadPersistedSessions()

    expect(restored.some((entry) => entry.id === session.id && entry.lost === true)).toBe(false)

    const listed = await owner.list()
    const live = listed.find((entry) => entry.id === session.id)
    expect(live?.status).toBe('running')

    const archive = JSON.parse(readFileSync(`${stateDir}/index.json`, 'utf8')) as Array<{
      id: string
      lost?: boolean
      status: string
    }>
    const stored = archive.find((entry) => entry.id === session.id)
    expect(stored?.lost).not.toBe(true)
    expect(stored?.status).toBe('running')

    await newcomer.kill(session.id)
    owner.disconnect()
    newcomer.disconnect()
  })
})
