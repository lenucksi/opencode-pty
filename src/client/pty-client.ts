/**
 * The PTY daemon client: the manager surface, one request per call.
 *
 * Connection, reconnects and the socket live in `pty-client-transport.ts`; this
 * file is the part callers use, and keeping the two apart keeps each under the
 * size the repository asks for.
 */

import { PtyClientTransport, type PtyClientOptions } from './pty-client-transport.ts'

export type { PtyClientOptions }

export class PtyClient extends PtyClientTransport {
  /** The PTYManager surface, one request per call. */
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

  async search(
    id: string,
    pattern: RegExp,
    offset?: number,
    limit?: number,
    budget?: number
  ): Promise<any> {
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

  /** The rest of the manager surface: methods the web UI and TUI need. */
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
    return {
      getRetention: async () => {
        const r = await this.request('get_retention')
        return r?.retention
      },
      updateRetention: async (policy: any) => {
        const r = await this.request('update_retention', { policy })
        return r?.pruned ?? []
      },
      getGeneration: async () => {
        const r = await this.request('get_generation')
        return r?.generation
      },
      getRoot: async () => {
        const r = await this.request('get_state_dir')
        return r?.stateDir
      },
      list: async () => this.request('list_persisted'),
      read: async (id: string, offset: number, limit: number) =>
        this.request('read_persisted', { id, offset, limit }),
      isEnabled: async () => true,
      close: async () => {},
    }
  }

  async setSessionStore(_store: any): Promise<void> {
    // No-op on client side; daemon owns the store
  }
}
