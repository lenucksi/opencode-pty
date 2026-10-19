import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'

describe('Daemon Integration', () => {
  const socketPath = `/tmp/opencode-pty-test-${Date.now()}.sock`
  const stateDir = `/tmp/opencode-pty-test-state-${Date.now()}`
  let daemonProc: ReturnType<typeof Bun.spawn>

  beforeAll(async () => {
    mkdirSync(stateDir, { recursive: true })
    daemonProc = Bun.spawn(
      ['bun', 'run', 'src/daemon/index.ts', '--socket', socketPath, '--state-dir', stateDir],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      }
    )
    // Wait for socket
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(250)
      if (existsSync(socketPath)) break
    }
    expect(existsSync(socketPath)).toBe(true)
  })

  afterAll(async () => {
    // `bun run <file>` can leave the script as a child, so killing the wrapper is
    // not enough: the daemon's own pid file names the process that owns the PTYs.
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
      rmSync(stateDir, { recursive: true })
    } catch {}
  })

  it('connects and pings', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()
    const pong = await client.ping()
    expect(pong.pong).toBe(true)
    expect(typeof pong.generation).toBe('string')
    client.disconnect()
  })

  it('spawns, reads, and kills a session', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()

    const session = await client.spawn({
      command: 'echo',
      args: ['hello daemon'],
      description: 'test',
    })
    expect(session.id).toMatch(/^pty_/)
    expect(session.status).toBe('running')

    // Wait for output
    await Bun.sleep(300)

    const readResult = await client.read(session.id, 0, 10)
    expect(readResult).not.toBeNull()
    expect(readResult.lines.join('')).toContain('hello daemon')

    const killed = await client.kill(session.id, true)
    expect(killed).toBe(true)

    client.disconnect()
  })

  it('lists sessions', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()

    await client.spawn({ command: 'echo', args: ['list test'], description: 'test' })
    await Bun.sleep(200)

    const sessions = await client.list()
    expect(sessions.length).toBeGreaterThan(0)

    client.disconnect()
  })

  it('resizes a session', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()

    const session = await client.spawn({ command: 'sleep', args: ['5'], description: 'test' })
    const resized = await client.resize(session.id, 120, 40)
    expect(resized).toBe(true)

    await client.kill(session.id, true)
    client.disconnect()
  })

  it('searches output', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()

    const session = await client.spawn({
      command: 'sh',
      args: ['-c', 'echo "line1"; echo "line2"; echo "error here"'],
      description: 'test',
    })
    await Bun.sleep(300)

    const result = await client.search(session.id, /error/, 0, 10)
    expect(result).not.toBeNull()
    expect(result.matches.length).toBeGreaterThan(0)

    await client.kill(session.id, true)
    client.disconnect()
  })

  it('restarts the daemon on request and reconnects', async () => {
    const client = new PtyClient({ socketPath, stateDir })
    await client.connect()

    const { oldPid, newPid } = await client.restartDaemon()
    expect(oldPid).not.toBeNull()
    expect(newPid).not.toBeNull()
    expect(newPid).not.toBe(oldPid)

    // A fresh daemon, not just a reconnect to the old one.
    const pong = await client.ping()
    expect(pong.pong).toBe(true)

    const spawned = await client.spawn({
      command: 'echo',
      args: ['after restart'],
      description: 'test',
    })
    await Bun.sleep(300)
    const read = await client.read(spawned.id, 0, 10)
    expect(read?.lines.join('')).toContain('after restart')
    await client.kill(spawned.id, true)
    client.disconnect()

    // This daemon was detached by the client, so the file's process cannot reap it.
    if (newPid !== null) {
      try {
        process.kill(newPid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  })
})
