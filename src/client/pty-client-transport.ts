/**
 * Connection half of the PTY daemon client.
 *
 * Owns the socket, the request/response correlation, the reconnect policy and the
 * queued writer. `PtyClient` in `pty-client.ts` adds the manager surface on top, so a
 * reader looking for "what does pty_list send" does not have to walk the connection
 * code first.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SessionNotifier } from '../adapters/types.ts'
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

/** Signal 0: permission check plus liveness, without disturbing the process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class PtyClientTransport {
  private socket: Bun.Socket<undefined> | null = null
  private socketPath: string
  private pidFile: string
  private stateDir: string
  private daemonBin: string
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
    this.socketPath =
      options.socketPath ?? join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'opencode-pty', 'ptyd.sock')
    this.pidFile = join(dirname(this.socketPath), 'ptyd.pid')
    this.stateDir = options.stateDir ?? sessionsRoot()
    this.daemonBin = options.daemonBin ?? defaultDaemonEntry()
  }

  /** Connect to the daemon, auto-starting it if needed. */
  async connect(): Promise<void> {
    if (this.connected) return
    this.stopped = false

    // Try to connect; if socket exists but connection fails, it's stale
    if (existsSync(this.socketPath)) {
      try {
        // Probe connection
        const probe = await Bun.connect({
          unix: this.socketPath,
          socket: { data: () => {}, close: () => {}, error: () => {} },
        })
        probe.end()
      } catch {
        // Stale socket, remove and start daemon
        try {
          ;(await import('node:fs')).unlinkSync(this.socketPath)
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
   * Start the daemon once, even when two callers race (a reconnect and an explicit
   * restart). Without this, both see the missing socket and both spawn; one binds
   * and the other unlinks its socket and listens on an unreachable inode.
   */
  private async startDaemon(): Promise<void> {
    if (this.starting !== null) return this.starting
    this.starting = this.spawnDaemon()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async spawnDaemon(): Promise<void> {
    const daemonEntry = this.daemonBin
    const socket = this.socketPath
    const stateDir = this.stateDir
    const stateHome =
      process.env.XDG_STATE_HOME ?? (process.env.HOME ? `${process.env.HOME}/.local/state` : '/tmp')
    const logPath = `${stateHome}/opencode/opencode-pty.log`
    // No shell: the paths are arguments, not text to be re-parsed. `setsid` is what
    // detaches the daemon from this host's session so it outlives it; `nohup` is not
    // needed once stdio points at a file.
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    const logFd = openSync(logPath, 'a', 0o600)
    try {
      const child = Bun.spawn(
        ['setsid', 'bun', daemonEntry, '--socket', socket, '--state-dir', stateDir],
        { stdin: 'ignore', stdout: logFd, stderr: logFd }
      )
      child.unref()
    } finally {
      closeSync(logFd)
    }
    // Wait for socket to appear
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (existsSync(this.socketPath)) return
    }
    throw new Error('Daemon did not start')
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
        console.log('[PtyClient] reconnected to daemon')
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
    const oldPid = this.readDaemonPid()
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
      if (!existsSync(this.socketPath)) break
      if (oldPid !== null && !isProcessAlive(oldPid)) break
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
    // A daemon killed before it cleaned up leaves a socket that refuses connections.
    if (existsSync(this.socketPath)) {
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

  private readDaemonPid(): number | null {
    if (!existsSync(this.pidFile)) return null
    const parsed = Number.parseInt(readFileSync(this.pidFile, 'utf8').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
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
