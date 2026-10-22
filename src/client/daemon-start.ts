/**
 * Starting the daemon on this machine.
 *
 * The daemon belongs to the machine, not to one opencode instance: every instance
 * on it talks to the same socket, and the socket path and the pid file beside it
 * are the machine's. So starting it is a machine-wide decision, and the pieces
 * that make it one live here rather than in the connection code: the probe that
 * tells a live daemon from a leftover file, the lock that says who starts, and the
 * spawn that waits for an answer instead of guessing.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Signal 0: permission check plus liveness, without disturbing the process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid a file names, if it names one. */
export function readPid(path: string): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * Is a daemon listening on this socket?
 *
 * A published socket path is only a hint: a daemon that died leaves the file
 * behind, and the path says nothing about whether anyone answers. Only a successful
 * connect proves a daemon is there.
 *
 * It is the only question that matters before a socket path is removed, because a
 * path with a live daemon behind it BELONGS to that daemon: removing it does not
 * stop the daemon, it makes it unreachable - it keeps running on an inode nobody
 * can reach, and the machine ends up with two daemons and one path.
 */
export async function socketAnswers(socketPath: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({
      unix: socketPath,
      socket: { data() {}, close() {}, error() {} },
    })
    probe.end()
    return true
  } catch {
    return false
  }
}

/** The socket the daemon on this machine listens on. */
export function defaultSocketPath(): string {
  return join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'opencode-pty', 'ptyd.sock')
}

/**
 * The pid of the daemon on this machine, if there is one.
 *
 * The daemon is shared: one socket path, one pid file, every opencode instance on
 * the machine. Reading the pid file is therefore the only way to ask whether there
 * IS one - and a restart must not start what is not there.
 */
export function sharedDaemonPid(): number | null {
  return readPid(join(dirname(defaultSocketPath()), 'ptyd.pid'))
}

/**
 * Where the daemon's own output goes.
 *
 * The client writes the daemon's stdout and stderr there, so this is the one file
 * that says why a daemon did not come up.
 */
export function daemonLogPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? (process.env.HOME ? `${process.env.HOME}/.local/state` : '/tmp')
  return join(stateHome, 'opencode', 'opencode-pty.log')
}

/**
 * Take the machine-wide right to start the daemon.
 *
 * `O_EXCL` is the whole mechanism: the file's existence IS the lock, so it holds
 * between processes and needs no cleanup by a crashed owner. A lock left behind by
 * a client that died is taken over, because a dead owner must not block the
 * machine forever.
 */
export function acquireStartLock(lockPath: string): boolean {
  const claim = (): boolean => {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch {
      return false
    }
  }
  if (claim()) return true
  const owner = readPid(lockPath)
  if (owner !== null && isProcessAlive(owner)) return false
  // The owner is gone: take the lock over.
  try {
    unlinkSync(lockPath)
  } catch {
    return false
  }
  return claim()
}

export function releaseStartLock(lockPath: string): void {
  try {
    if (readPid(lockPath) === process.pid) unlinkSync(lockPath)
  } catch {
    // Already gone, or taken over by another client.
  }
}

/**
 * Why the daemon is not there, in a form a reader can act on.
 *
 * "Daemon did not start" is a symptom; the socket path and the log are what a
 * reader needs to see next.
 */
export function daemonMissing(socketPath: string, logPath: string): string {
  return `The PTY daemon did not start: nothing is listening on ${socketPath}. Its log is at ${logPath}.`
}

/**
 * Wait for a daemon to answer on the socket.
 *
 * Used when another client is starting one: the wait is the cooperation, and the
 * answer at the end is the proof - a socket file without a daemon behind it is
 * what a failed start leaves behind.
 */
export async function waitForSocket(socketPath: string, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (existsSync(socketPath)) break
  }
  if (await socketAnswers(socketPath)) return
  throw new Error(daemonMissing(socketPath, daemonLogPath()))
}

/**
 * Start the daemon, or wait for the one another client is starting.
 *
 * The daemon belongs to the machine, not to one opencode instance: every instance
 * on it talks to the same socket. "Start it" is therefore a machine-wide decision
 * and has to be one - two clients that each spawn a daemon leave a loser behind,
 * and the loser is the one that unlinks the winner's socket. The lock file says
 * who starts; the others wait for the socket instead of starting a second.
 */
export async function startDaemon(options: {
  readonly daemonBin: string
  readonly socketPath: string
  readonly stateDir: string
  readonly lockPath: string
  readonly steps: number
}): Promise<void> {
  // The lock lives beside the socket, and the lock cannot be taken in a directory
  // that does not exist yet. On a machine where the daemon has never run, that
  // directory is missing - and a lock that cannot be taken is a lock that is
  // never held, which is a daemon nobody starts.
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
  if (!acquireStartLock(options.lockPath)) {
    // Another client is starting one. Waiting for its socket is the whole
    // cooperation: a second daemon would only fight the first for the path.
    await waitForSocket(options.socketPath, options.steps)
    return
  }
  try {
    await spawnDaemon(options)
  } finally {
    releaseStartLock(options.lockPath)
  }
}

async function spawnDaemon(options: {
  readonly daemonBin: string
  readonly socketPath: string
  readonly stateDir: string
  readonly steps: number
}): Promise<void> {
  const { daemonBin, socketPath, stateDir } = options
  const logPath = daemonLogPath()
  // No shell: the paths are arguments, not text to be re-parsed. `setsid` is what
  // detaches the daemon from this host's session so it outlives it; `nohup` is not
  // needed once stdio points at a file.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  const logFd = openSync(logPath, 'a', 0o600)
  try {
    const child = Bun.spawn(
      ['setsid', 'bun', daemonBin, '--socket', socketPath, '--state-dir', stateDir],
      {
        stdin: 'ignore',
        stdout: logFd,
        stderr: logFd,
        // The environment the client HAS, passed on: a child does not inherit a
        // runtime change to `process.env`, and the daemon logs where the client
        // says it logs - the two have to agree on that path.
        env: { ...process.env },
      }
    )
    child.unref()
  } finally {
    closeSync(logFd)
  }
  // Wait for socket to appear
  for (let i = 0; i < options.steps; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (existsSync(socketPath)) return
  }
  // The file can be there without a daemon behind it: one that lost the race
  // exits, and one that was killed leaves the file. Only an answer proves a
  // daemon - and the answer may come from the daemon that won the race.
  if (await socketAnswers(socketPath)) return
  throw new Error(daemonMissing(socketPath, logPath))
}
