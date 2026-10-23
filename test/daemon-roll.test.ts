/**
 * Rolling the daemon, from the surfaces that can ask for it.
 *
 * The daemon is machine state that every opencode instance on the machine shares:
 * one socket path, one pid file, one process that owns every PTY. So the roll
 * happens in the manager, and the surfaces ask for it - the TUI over the plugin's
 * RPC, the web interface over HTTP.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'
import { daemonRestartFromData } from '../src/v2/rpc.ts'

const temps: string[] = []

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A machine of its own: the daemon's socket and the archive beside it. */
function machine(): { runtimeDir: string; stateDir: string } {
  const root = `/tmp/opencode-pty-roll-${Date.now()}-${temps.length}`
  temps.push(root)
  mkdirSync(root, { recursive: true })
  return { runtimeDir: `${root}/run`, stateDir: `${root}/state` }
}

describe('what a roll answers', () => {
  it('reads the pids and says whether anything was rolled', () => {
    expect(daemonRestartFromData({ restarted: true, oldPid: 100, newPid: 200 })).toEqual({
      restarted: true,
      oldPid: 100,
      newPid: 200,
    })
  })

  it('treats a missing pid as no pid', () => {
    expect(daemonRestartFromData({ restarted: false, oldPid: 0, newPid: 0 })).toEqual({
      restarted: false,
      oldPid: null,
      newPid: null,
    })
  })

  it('drops an answer that is not one', () => {
    expect(daemonRestartFromData(undefined)).toBeNull()
    expect(daemonRestartFromData('rolled')).toBeNull()
    expect(daemonRestartFromData({})).toEqual({ restarted: false, oldPid: null, newPid: null })
  })
})

describe('the roll itself', () => {
  // Where the daemon lives, for the manager's own answers: `sharedDaemonPid` reads
  // the pid file the runtime directory implies, and the daemon writes it beside its
  // socket.
  let previousRuntimeDir: string | undefined

  afterAll(() => {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir
  })

  it('ends the daemon and brings a new one up', async () => {
    const m = machine()
    previousRuntimeDir = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = m.runtimeDir
    mkdirSync(m.runtimeDir, { recursive: true })
    const socketPath = `${m.runtimeDir}/opencode-pty/ptyd.sock`
    const daemon = Bun.spawn(
      [
        'bun',
        'run',
        'src/daemon/index.ts',
        '--socket',
        socketPath,
        '--state-dir',
        `${m.stateDir}/sessions`,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        await Bun.sleep(100)
        if (existsSync(`${m.runtimeDir}/opencode-pty/ptyd.pid`)) break
      }
      const client = new PtyClient({ socketPath, stateDir: `${m.stateDir}/sessions` })
      await client.connect()
      const before = await client.ping()
      const beforePid = before.pid ?? 0
      expect(beforePid).toBeGreaterThan(0)

      // The roll, on THIS machine's daemon - the client's own socket path, not the
      // machine's: a test that rolled the real one would be a test that reaches
      // out of the sandbox.
      const rolled = await client.restartDaemon()
      expect(rolled.oldPid ?? 0).toBe(beforePid)
      expect(rolled.newPid).toBeGreaterThan(0)
      expect(rolled.newPid).not.toBe(rolled.oldPid ?? 0)

      // The new daemon answers, and the old one is gone.
      const after = await client.ping()
      expect(after.pid).toBe(rolled.newPid ?? 0)

      // The status a surface draws its line from names the daemon that is running
      // now, not the one that was rolled away.
      const { daemonPid } = await import('../src/plugin/pty/manager.ts')
      expect(await daemonPid()).toBe(rolled.newPid ?? 0)
      client.disconnect()
    } finally {
      daemon.kill()
    }
  }, 30_000)
})
