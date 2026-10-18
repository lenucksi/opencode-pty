/**
 * Client for the opencode-pty daemon.
 *
 * Mirrors the PTYManager API but communicates over a Unix socket. When the
 * daemon is not running, it is auto-started (setsid + nohup) and the client
 * waits for the socket to appear.
 *
 * All methods are async because IPC is inherently asynchronous.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeMessage, parseMessage, isPush } from '../daemon/protocol.ts'
import { notifyRawOutput, notifySessionUpdate, notifySessionRemoved } from '../plugin/pty/manager-notifications.ts'

export interface PtyClientOptions {
  socketPath?: string
  stateDir?: string
  daemonBin?: string
}

export class PtyClient {
  private socket: any = null
  private socketPath: string
  private stateDir: string
  private daemonBin: string
  private requestId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private pushHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  private connected = false
  private buffer = ''
  private reconnecting = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10

  constructor(options: PtyClientOptions = {}) {
    this.socketPath = options.socketPath ?? join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'opencode-pty', 'ptyd.sock')
    this.stateDir = options.stateDir ?? ''
    this.daemonBin = options.daemonBin ?? 'bun'
  }

  /** Connect to the daemon, auto-starting it if needed. */
  async connect(): Promise<void> {
    if (this.connected) return

    // Try to connect
    if (!existsSync(this.socketPath)) {
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
            close: () => {
              this.connected = false
              console.warn('[PtyClient] daemon disconnected')
              this.scheduleReconnect()
            },
            error: (_socket, err) => {
              console.error('[PtyClient] socket error:', err)
            },
          },
        })
        this.connected = true
        this.reconnectAttempts = 0
        this.registerPushHandlers()
        return
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    throw new Error('Failed to connect to daemon')
  }

  private async startDaemon(): Promise<void> {
    // Use setsid + nohup to detach the daemon from this process
    Bun.spawn(['sh', '-c', `setsid nohup bun run ${this.daemonBin} --socket ${this.socketPath} --state-dir ${this.stateDir} </dev/null >/dev/null 2>&1 &`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
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
  private async request(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.connected) await this.connect()
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(encodeMessage({ id, method, params }))
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
  onPush(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.pushHandlers.set(method, handler)
  }

  // --- PTYManager-compatible API (async) ---

  async spawn(opts: any): Promise<any> {
    return this.request('spawn', opts)
  }

  async write(id: string, data: string): Promise<boolean> {
    const r = await this.request('write', { id, data })
    return r?.success ?? false
  }

  async read(id: string, offset?: number, limit?: number, budget?: number): Promise<any> {
    return this.request('read', { id, offset, limit, budget })
  }

  async search(id: string, pattern: RegExp, offset?: number, limit?: number, budget?: number): Promise<any> {
    return this.request('search', { id, pattern: pattern.source, offset, limit, budget })
  }

  async list(): Promise<any[]> {
    return this.request('list')
  }

  async get(id: string): Promise<any> {
    return this.request('get', { id })
  }

  async kill(id: string, cleanup = false): Promise<boolean> {
    const r = await this.request('kill', { id, cleanup })
    return r?.success ?? false
  }

  async resize(id: string, cols?: number, rows?: number): Promise<boolean> {
    const r = await this.request('resize', { id, cols, rows })
    return r?.success ?? false
  }

  async ping(): Promise<{ pong: boolean; generation: string }> {
    return this.request('ping')
  }

  async heartbeat(): Promise<void> {
    await this.request('heartbeat')
  }

  /** Start sending heartbeats. */
  startHeartbeat(): void {
    setInterval(() => {
      this.heartbeat().catch(() => {})
    }, 30000)
  }

  // --- Additional PTYManager-compatible methods (IPC) ---

  async getSession(id: string): Promise<any> {
    return this.request('get_session', { id })
  }

  async getSessionLog(id: string, options: { tail?: number } = {}): Promise<string | null> {
    const r = await this.request('get_session_log', { id, ...options })
    return r?.log ?? null
  }

  async describeMissingSession(id: string): Promise<any> {
    return this.request('describe_missing_session', { id })
  }

  async describeServer(): Promise<any> {
    return this.request('describe_server')
  }

  async getRawBuffer(id: string, since?: number, budget?: number): Promise<any> {
    return this.request('get_raw_buffer', { id, since, budget })
  }

  async readSince(id: string, since: number, budget?: number): Promise<any> {
    return this.request('read_since', { id, since, budget })
  }

  async cleanupBySession(parentSessionId: string): Promise<void> {
    await this.request('cleanup_by_session', { parentSessionId })
  }

  async loadPersistedSessions(): Promise<any[]> {
    return this.request('load_persisted_sessions')
  }

  async bulkRemove(ids: string[]): Promise<any> {
    return this.request('bulk_remove', { ids })
  }

  async restoreSessions(ids: string[]): Promise<any> {
    return this.request('restore_sessions', { ids })
  }

  async clearAllSessions(): Promise<void> {
    await this.request('clear_all_sessions')
  }

  noteClientSize(cols: number, rows: number): void {
    this.request('note_client_size', { cols, rows }).catch(() => {})
  }

  async getSessionStore(): Promise<any> {
    const client = this
    return {
      getRetention: async () => {
        const r = await client.request('get_retention')
        return r?.retention
      },
      updateRetention: async (policy: any) => {
        const r = await client.request('update_retention', { policy })
        return r?.pruned ?? []
      },
      getGeneration: async () => {
        const r = await client.request('get_generation')
        return r?.generation
      },
      getRoot: async () => {
        const r = await client.request('get_state_dir')
        return r?.stateDir
      },
      list: async () => client.request('list_persisted'),
      read: async (id: string, offset: number, limit: number) => client.request('read_persisted', { id, offset, limit }),
      isEnabled: async () => true,
      close: async () => {},
    }
  }

  async setSessionStore(_store: any): Promise<void> {
    // No-op on client side; daemon owns the store
  }

  private registerPushHandlers(): void {
    this.onPush('raw_data', (params) => {
      notifyRawOutput(params.sessionId as string, params.rawData as string, params.offset as number)
    })
    this.onPush('session_update', (params) => {
      notifySessionUpdate(params.session as any)
    })
    this.onPush('session_removed', (params) => {
      notifySessionRemoved(params.sessionId as string)
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
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
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

  disconnect(): void {
    if (this.socket) {
      try { this.socket.end() } catch {}
      this.connected = false
    }
  }
}
