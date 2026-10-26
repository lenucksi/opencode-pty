/**
 * Connection half of the PTY daemon client.
 *
 * Owns the socket, the request/response correlation, the reconnect policy and the
 * queued writer. `PtyClient` in `pty-client.ts` adds the manager surface on top, so a
 * reader looking for "what does pty_list send" does not have to walk the connection
 * code first.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SessionNotifier } from '../adapters/types.ts'
import {
  defaultSocketPath,
  isProcessAlive,
  readPid,
  socketAnswers,
  startDaemon,
} from './daemon-start.ts'
import { type DaemonRequest, encodeMessage, isPush, parseMessage } from '../daemon/protocol.ts'
import { SocketWriter } from '../daemon/socket-writer.ts'
import {
  notifyRawOutput,
  notifySessionRemoved,
  notifySessionUpdate,
} from '../plugin/pty/manager-notifications.ts'
import { sessionsRoot } from '../plugin/pty/state-paths.ts'
import type { PTYSession, PTYSessionInfo } from '../plugin/pty/types.ts'

export interface PtyClientOptions {
  socketPath?: string
  stateDir?: string
  daemonBin?: string
  /**
   * How long to wait for a daemon to answer before giving up.
   *
   * Ten seconds is a long time for a daemon to start, and it is the window in which
   * a client waits rather than working. It is an option because a test must not
   * spend ten seconds proving that a daemon that cannot start says so.
   */
  startTimeoutMs?: number
}

/**
 * The daemon entry beside this module.
 *
 * The built client sits next to `index.js`; a source checkout has `index.ts` and no
 * compiled sibling. Preferring the built file keeps the package honest, and the `.ts`
 * fallback is what lets the harness drive the source tree without a build step of its
 * own.
 */
function defaultDaemonEntry(): string {
  const js = new URL('../daemon/index.js', import.meta.url)
  if (existsSync(js)) return js.pathname
  return new URL('../daemon/index.ts', import.meta.url).pathname
}

export class PtyClientTransport {
  private socket: Bun.Socket<undefined> | null = null
  private socketPath: string
  private pidFile: string
  private lockFile: string
  private stateDir: string
  private daemonBin: string
  private startTimeoutMs: number
  private requestId = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private pushHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  protected notifier: SessionNotifier | null = null
  private writer: SocketWriter | null = null
  private connected = false
  private buffer = ''
  private reconnecting = false
  /** Set by disconnect(): an intentional end must not schedule a reconnect. */
  private stopped = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10

  constructor(options: PtyClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath()
    this.pidFile = join(dirname(this.socketPath), 'ptyd.pid')
    this.lockFile = join(dirname(this.socketPath), 'ptyd.lock')
    this.stateDir = options.stateDir ?? sessionsRoot()
    this.daemonBin = options.daemonBin ?? defaultDaemonEntry()
    this.startTimeoutMs = options.startTimeoutMs ?? 10_000
  }

  /** Connect to the daemon, auto-starting it if needed. */
  /**
   * Connect to the daemon, auto-starting it if needed.
   *
   * One connection at a time. A request that finds the client disconnected and the
   * reconnect that is already on its way would otherwise both connect - and the
   * second connection would replace the first, so the answer to the request would
   * arrive on a socket nobody reads any more.
   */
  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connecting !== null) return this.connecting
    this.connecting = this.connectOnce()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private connecting: Promise<void> | null = null

  private async connectOnce(): Promise<void> {
    this.stopped = false

    // A socket that answers is a daemon's; a socket that does not is a leftover.
    if (existsSync(this.socketPath)) {
      if (!(await socketAnswers(this.socketPath))) {
        // Stale socket, remove and start daemon
        try {
          unlinkSync(this.socketPath)
        } catch {
          // Already removed by the daemon's shutdown.
        }
        await this.startDaemon()
      }
    } else {
      await this.startDaemon()
    }

    // Connect with retries
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        this.socket = await Bun.connect({
          unix: this.socketPath,
          socket: {
            data: (_socket, data) => {
              this.buffer += new TextDecoder().decode(data)
              this.processBuffer()
            },
            drain: () => {
              this.writer?.flush()
            },
            close: () => {
              this.connected = false
              // A partial line from a lost connection would otherwise prefix every
              // response of the next one, and each of them would fail to parse.
              this.buffer = ''
              this.writer?.close()
              this.writer = null
              console.warn('[PtyClient] daemon disconnected')
              // The requests that were in flight will never be answered: the
              // daemon is gone, and the socket they went out on is closed. Saying
              // so now beats leaving the caller waiting for a timeout that says
              // nothing about what happened.
              for (const [, pending] of this.pending) {
                pending.reject(new Error('the daemon disconnected before it answered'))
              }
              this.pending.clear()
              // A disconnect the caller asked for is not a lost daemon. Without
              // this, every `disconnect()` armed a reconnect that started a new
              // daemon about a second later.
              if (!this.stopped) this.scheduleReconnect()
            },
            error: (_socket, err) => {
              console.error('[PtyClient] socket error:', err)
            },
          },
        })
        this.connected = true
        this.buffer = ''
        this.writer = new SocketWriter(this.socket)
        this.reconnectAttempts = 0
        this.registerPushHandlers()
        return
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    throw new Error('Failed to connect to daemon')
  }

  private starting: Promise<void> | null = null

  /**
   * Start the daemon, or wait for the one another client is starting.
   *
   * The lock and the spawn live in `daemon-start.ts`: starting the daemon is a
   * machine-wide decision, and the code that makes it one belongs with the paths
   * it is about.
   */
  private async startDaemon(): Promise<void> {
    if (this.starting !== null) return this.starting
    this.starting = startDaemon({
      daemonBin: this.daemonBin,
      socketPath: this.socketPath,
      stateDir: this.stateDir,
      lockPath: this.lockFile,
      timeoutMs: this.startTimeoutMs,
    })
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      const msg = parseMessage(line)
      if (!msg) continue
      if (isPush(msg)) {
        const handler = this.pushHandlers.get(msg.method)
        if (handler) handler(msg.params)
      } else if ('id' in msg && ('result' in msg || 'error' in msg)) {
        const pending = this.pending.get(msg.id)
        if (pending) {
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      }
    }
  }

  /** Send a request and wait for the response. */
  protected async request<T = unknown>(method: string, params?: object): Promise<T> {
    if (!this.connected) await this.connect()
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      // The wire carries `unknown`; the caller's declaration is the assertion.
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      const message: DaemonRequest =
        params === undefined
          ? { id, method }
          : { id, method, params: params as Record<string, unknown> }
      this.writer?.enqueue(encodeMessage(message))
      // Timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 30000)
    })
  }

  /** Register a push handler. */
  protected onPush(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.pushHandlers.set(method, handler)
  }

  private registerPushHandlers(): void {
    this.onPush('raw_data', (params) => {
      notifyRawOutput(params.sessionId as string, params.rawData as string, params.offset as number)
    })
    this.onPush('session_update', (params) => {
      notifySessionUpdate(params.session as PTYSessionInfo)
    })
    this.onPush('session_removed', (params) => {
      notifySessionRemoved(params.sessionId as string)
    })
    this.onPush('exit_notification', async (params) => {
      if (this.notifier?.sendExitNotification) {
        await this.notifier.sendExitNotification(
          params.session as PTYSession,
          params.exitCode as number
        )
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[PtyClient] max reconnect attempts reached')
      return
    }
    this.reconnecting = true
    this.reconnectAttempts++
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)
    setTimeout(async () => {
      try {
        await this.connect()
        this.reconnecting = false
        this.reconnectAttempts = 0
        this.registerPushHandlers()
        console.warn('[PtyClient] reconnected to daemon')
      } catch (err) {
        console.warn('[PtyClient] reconnect failed:', err)
        this.reconnecting = false
        this.scheduleReconnect()
      }
    }, delay)
  }

  setNotifier(notifier: SessionNotifier | null): void {
    this.notifier = notifier
  }

  setNotificationManager(_manager: unknown): void {
    // No-op on client; daemon handles notifications
  }

  /**
   * Stop the running daemon and bring a fresh one up.
   *
   * The pid comes from the pid file, not from a connection: a daemon that is still
   * serving other clients is exactly the one worth restarting, and it may have
   * outlived the process that started it. SIGTERM lets it flush the archive and
   * remove its socket before we connect again.
   *
   * Ends every session the daemon owns. That is the point of a restart - the PTY
   * masters belong to that process - so callers have to say so.
   */
  async restartDaemon(): Promise<{ oldPid: number | null; newPid: number | null }> {
    const oldPid = await this.daemonPid()
    // Hold off the automatic reconnect: it would race the connect below.
    this.reconnecting = true
    if (oldPid !== null) {
      try {
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // Already gone; the socket check below still runs.
      }
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (oldPid !== null && !isProcessAlive(oldPid)) break
      if (oldPid === null && !existsSync(this.socketPath)) break
      await Bun.sleep(250)
    }

    // Drop the old connection without letting its close handler reconnect first.
    try {
      this.socket?.end()
    } catch {
      // The socket is already closed; the state below is what matters.
    }
    this.socket = null
    this.connected = false
    this.buffer = ''
    this.writer?.close()
    this.writer = null
    // A socket path with a live daemon behind it belongs to that daemon: removing it
    // does not stop the daemon, it makes it unreachable - it keeps running on an
    // inode nobody can reach, and the machine ends up with two daemons and one path.
    // Another instance may have restarted the daemon in the meantime, and that
    // daemon is the one to use.
    if (existsSync(this.socketPath) && !(await socketAnswers(this.socketPath))) {
      // A daemon killed before it cleaned up leaves a socket that refuses
      // connections.
      try {
        unlinkSync(this.socketPath)
      } catch {
        // Another process removed it first.
      }
    }
    this.reconnecting = false
    await this.connect()
    // The socket appears before the pid file: the daemon listens, then writes it.
    // Reading too early reports null and, worse, leaves the caller with no pid to
    // stop a process it just started.
    let newPid = this.readDaemonPid()
    for (let attempt = 0; attempt < 20 && newPid === null; attempt += 1) {
      await Bun.sleep(100)
      newPid = this.readDaemonPid()
    }
    return { oldPid, newPid }
  }

  /**
   * Which process is the daemon.
   *
   * Asked of the daemon itself, because the daemon knows and the pid file only
   * guesses: a file left behind by a daemon that died names a process that is
   * gone, and a file that was written by a daemon that lost the path names the
   * wrong one. The file is the fallback for a daemon that does not answer.
   */
  async daemonPid(): Promise<number | null> {
    if (this.connected) {
      try {
        const pong = await this.request<{ pid?: number }>('ping')
        if (typeof pong.pid === 'number' && pong.pid > 0) return pong.pid
      } catch {
        // The daemon did not answer; the pid file is what is left.
      }
    }
    return this.readDaemonPid()
  }

  private readDaemonPid(): number | null {
    return readPid(this.pidFile)
  }

  disconnect(): void {
    this.stopped = true
    if (this.socket) {
      try {
        this.socket.end()
      } catch {
        // Already closed.
      }
      this.connected = false
      this.writer?.close()
      this.writer = null
    }
  }
}
