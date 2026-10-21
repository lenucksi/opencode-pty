/**
 * What happens when two daemons want the same socket.
 *
 * The daemon on a machine is shared by every opencode instance, so "two daemons
 * want the same socket" is not hypothetical: a restart, a reconnect and a second
 * instance can all reach for it at once. These cases are the observable half of
 * that - one daemon, one path, the loser out of the way, and a failure that says
 * where to look.
 *
 * Every case runs its own daemon in its own directory, because the socket path
 * decides where the pid file lives and a shared one would make the cases talk to
 * each other's daemon.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'

import { PtyClient } from '../src/client/pty-client.ts'

const stamp = Date.now()

/** A directory per case: the socket, the pid file and the lock file live in it. */
function caseDir(name: string): string {
  const dir = `/tmp/opencode-pty-${name}-${stamp}`
  mkdirSync(dir, { recursive: true })
  return dir
}

function pidFileOf(dir: string): string {
  return `${dir}/ptyd.pid`
}

function daemonPid(dir: string): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(pidFileOf(dir), 'utf8').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function startDaemon(dir: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      'bun',
      'run',
      'src/daemon/index.ts',
      '--socket',
      `${dir}/ptyd.sock`,
      '--state-dir',
      `${dir}/sessions`,
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  )
}

/** Stop a daemon by its pid: the wrapper of `bun run` is not the daemon itself. */
function stopDaemon(pid: number | null): void {
  if (pid === null) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(100)
  }
  return predicate()
}

/**
 * How many daemons serve this socket path.
 *
 * The count is the whole point: two daemons on one path means one of them is
 * unreachable, and the sessions it owns are unreachable with it.
 */
function daemonsOn(socketPath: string): number {
  const ps = Bun.spawnSync(['ps', '-eo', 'pid,args'])
  return ps.stdout
    .toString()
    .split('\n')
    .filter((line) => line.includes('daemon/index') && line.includes(socketPath)).length
}

describe('One daemon per machine', () => {
  it('retires a daemon whose socket path was taken over', async () => {
    const dir = caseDir('supersede')
    const first = startDaemon(dir)
    let firstPid: number | null = null
    let second: ReturnType<typeof Bun.spawn> | null = null
    try {
      expect(await waitFor(() => daemonPid(dir) !== null)).toBe(true)
      firstPid = daemonPid(dir)
      if (firstPid === null) throw new Error('the daemon wrote no pid file')

      // The path is taken: a second daemon binds it and names itself in the pid file.
      unlinkSync(`${dir}/ptyd.sock`)
      second = startDaemon(dir)
      expect(await waitFor(() => daemonPid(dir) !== null && daemonPid(dir) !== firstPid)).toBe(true)

      // The daemon that lost the path notices on its own and leaves. It is
      // listening on an inode nobody can reach, and it holds every session it owns.
      expect(await waitFor(() => !alive(firstPid as number), 8000)).toBe(true)

      // And it did not take the successor's socket or pid file with it.
      expect(existsSync(`${dir}/ptyd.sock`)).toBe(true)
      expect(daemonPid(dir)).not.toBe(firstPid)
    } finally {
      stopDaemon(daemonPid(dir))
      second?.kill()
      first.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives two clients that connect at once one daemon', async () => {
    const dir = caseDir('two-clients')
    const socketPath = `${dir}/ptyd.sock`
    const a = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
    const b = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
    try {
      await Promise.all([a.connect(), b.connect()])
      const pong = await a.ping()
      expect(pong.pong).toBe(true)
      const other = await b.ping()
      expect(other.pong).toBe(true)
      // One daemon owns the path, and the pid file names it.
      const pid = daemonPid(dir)
      expect(pid).not.toBeNull()
      expect(alive(pid as number)).toBe(true)
    } finally {
      a.disconnect()
      b.disconnect()
      stopDaemon(daemonPid(dir))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves one daemon behind after a restart', async () => {
    const dir = caseDir('restart')
    const socketPath = `${dir}/ptyd.sock`
    const client = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
    try {
      await client.connect()
      const before = daemonPid(dir)
      expect(before).not.toBeNull()

      const { oldPid, newPid } = await client.restartDaemon()
      expect(oldPid).toBe(before)
      expect(newPid).not.toBeNull()
      expect(newPid).not.toBe(oldPid)
      // The old daemon is gone, the new one owns the path, and it answers.
      expect(await waitFor(() => !alive(oldPid as number))).toBe(true)
      expect(daemonPid(dir)).toBe(newPid)
      const pong = await client.ping()
      expect(pong.pong).toBe(true)
    } finally {
      client.disconnect()
      stopDaemon(daemonPid(dir))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts one daemon when two clients connect at once', async () => {
    const dir = caseDir('one-start')
    const socketPath = `${dir}/ptyd.sock`
    // The client's log is where a spawn shows up: the daemon's first words land
    // there, and so does the line a daemon writes when it finds the path taken.
    const previousStateHome = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = `${dir}/state`
    const logPath = `${dir}/state/opencode/opencode-pty.log`
    const a = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
    const b = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
    try {
      await Promise.all([a.connect(), b.connect()])
      expect((await a.ping()).pong).toBe(true)
      expect((await b.ping()).pong).toBe(true)
      // One daemon, not two that fight over the path: a second daemon would either
      // say so in the log before it steps aside, or fail to bind and take the
      // machine's log down with it.
      const log = readFileSync(logPath, 'utf8')
      expect(log).not.toContain('another daemon is already listening')
      expect(log).not.toContain('EADDRINUSE')
      expect(daemonsOn(socketPath)).toBe(1)
    } finally {
      a.disconnect()
      b.disconnect()
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousStateHome
      stopDaemon(daemonPid(dir))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills the daemon that answers, not the one the pid file names', async () => {
    const dir = caseDir('right-pid')
    const socketPath = `${dir}/ptyd.sock`
    const daemon = startDaemon(dir)
    // A live process that is not the daemon: a pid file naming it is what a
    // recycled pid looks like from the outside.
    const decoy = Bun.spawn(['sleep', '30'])
    try {
      expect(await waitFor(() => daemonPid(dir) !== null)).toBe(true)
      const realPid = daemonPid(dir) as number
      const client = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
      await client.connect()
      writeFileSync(pidFileOf(dir), `${decoy.pid}\n`)

      const { oldPid } = await client.restartDaemon()
      client.disconnect()

      // The daemon that answered is the one that was stopped - it says who it is.
      expect(oldPid).toBe(realPid)
      expect(await waitFor(() => !alive(realPid))).toBe(true)
      // And the process the file named was left alone.
      expect(alive(decoy.pid)).toBe(true)
    } finally {
      decoy.kill()
      stopDaemon(daemonPid(dir))
      daemon.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the daemon that owns the path, and the sessions it owns', async () => {
    const dir = caseDir('no-theft')
    const socketPath = `${dir}/ptyd.sock`
    const daemon = startDaemon(dir)
    // A live process that is not the daemon: the pid file naming it is what a
    // recycled pid looks like from the outside.
    const decoy = Bun.spawn(['sleep', '30'])
    try {
      expect(await waitFor(() => daemonPid(dir) !== null)).toBe(true)
      const client = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
      await client.connect()
      const spawned = await client.spawn({
        command: 'sleep',
        args: ['30'],
        description: 'owned by the daemon',
      })
      expect(spawned.id).toBeTruthy()

      // The pid file names the decoy, not the daemon. A restart that believed the
      // file would kill the wrong process and then take the socket away from the
      // daemon that IS serving it - leaving that daemon on an inode nobody can
      // reach, with a session nobody can see.
      writeFileSync(pidFileOf(dir), `${decoy.pid}\n`)
      // A client that is not connected: it has nothing but the file to go on.
      const stranger = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
      await stranger.restartDaemon()
      stranger.disconnect()
      client.disconnect()

      // The daemon that answers is the one that was there, and the session it owns
      // is still running - not a restored leftover.
      const again = new PtyClient({ socketPath, stateDir: `${dir}/sessions` })
      await again.connect()
      const sessions = await again.list()
      const session = sessions.find((entry) => entry.id === spawned.id)
      expect(session?.status).toBe('running')
      again.disconnect()
    } finally {
      decoy.kill()
      stopDaemon(daemonPid(dir))
      daemon.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says where to look when a daemon cannot start', async () => {
    const dir = caseDir('no-daemon')
    const socketPath = `${dir}/ptyd.sock`
    const client = new PtyClient({
      socketPath,
      daemonBin: `${dir}/there-is-no-daemon-here`,
      startTimeoutMs: 750,
    })
    let message = ''
    try {
      await client.connect()
    } catch (error) {
      message = String(error)
    }
    // A symptom is not enough: the reader needs the path and the log.
    expect(message).toContain('did not start')
    expect(message).toContain(socketPath)
    expect(message).toContain('opencode-pty.log')
    rmSync(dir, { recursive: true, force: true })
  })
})
