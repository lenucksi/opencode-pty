/**
 * The PTY daemon client: the manager surface, one request per call.
 *
 * Connection, reconnects and the socket live in `pty-client-transport.ts`; this
 * file is the part callers use, and keeping the two apart keeps each under the
 * size the repository asks for.
 *
 * The return types mirror `PTYManager` on purpose. That is what lets the tools and
 * the web handlers be written once against `PTYManager | PtyClient`: the daemon is a
 * transport, not a different API.
 */

import type { MissingSessionInfo, ServerDescription } from '../plugin/pty/manager.ts'
import type { BoundedReadResult, BoundedSearchResult } from '../plugin/pty/output-manager.ts'
import type { BoundedRawResult } from '../plugin/pty/read-budget.ts'
import type { ScreenSnapshot } from '../plugin/pty/screen.ts'
import type { PersistedSession, RetentionPolicy } from '../plugin/pty/session-store.ts'
import type {
  BulkRemoveResult,
  PTYSession,
  PTYSessionInfo,
  RestoreSessionsResult,
  SpawnOptions,
} from '../plugin/pty/types.ts'
import { PtyClientTransport, type PtyClientOptions } from './pty-client-transport.ts'

export type { PtyClientOptions }

/**
 * The store as a daemon client can offer it.
 *
 * Every method is async because the answer comes over the socket, unlike the
 * in-process `SessionStore`. Callers that accept either await the result, which is
 * a no-op for the synchronous store.
 */
export interface PtySessionStore {
  getRetention(): Promise<RetentionPolicy>
  updateRetention(policy: Partial<RetentionPolicy>): Promise<string[]>
  getGeneration(): Promise<string>
  getRoot(): Promise<string>
  list(): Promise<PersistedSession[]>
  read(id: string, offset: number, limit: number): Promise<BoundedReadResult | null>
  isEnabled(): Promise<boolean>
  close(): Promise<void>
}

export class PtyClient extends PtyClientTransport {
  /** The PTYManager surface, one request per call. */
  async spawn(opts: SpawnOptions): Promise<PTYSessionInfo> {
    return this.request<PTYSessionInfo>('spawn', opts)
  }

  async write(id: string, data: string): Promise<boolean> {
    const r = await this.request<{ success?: boolean }>('write', { id, data })
    return r?.success ?? false
  }

  async read(
    id: string,
    offset?: number,
    limit?: number,
    budget?: number
  ): Promise<BoundedReadResult | null> {
    return this.request<BoundedReadResult | null>('read', { id, offset, limit, budget })
  }

  async search(
    id: string,
    pattern: RegExp,
    offset?: number,
    limit?: number,
    budget?: number
  ): Promise<BoundedSearchResult | null> {
    return this.request<BoundedSearchResult | null>('search', {
      id,
      pattern: pattern.source,
      offset,
      limit,
      budget,
    })
  }

  async list(): Promise<PTYSessionInfo[]> {
    return this.request<PTYSessionInfo[]>('list')
  }

  async get(id: string): Promise<PTYSessionInfo | null> {
    return this.request<PTYSessionInfo | null>('get', { id })
  }

  async kill(id: string, cleanup = false): Promise<boolean> {
    const r = await this.request<{ success?: boolean }>('kill', { id, cleanup })
    return r?.success ?? false
  }

  async resize(id: string, cols?: number, rows?: number): Promise<boolean> {
    const r = await this.request<{ success?: boolean }>('resize', { id, cols, rows })
    return r?.success ?? false
  }

  async ping(): Promise<{ pong: boolean; generation: string }> {
    return this.request<{ pong: boolean; generation: string }>('ping')
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
  async screen(
    id: string,
    options: { cols?: number; rows?: number; scrollback?: number } = {}
  ): Promise<ScreenSnapshot | null> {
    return this.request<ScreenSnapshot | null>('screen', { id, ...options })
  }

  async getSession(id: string): Promise<PTYSession | null> {
    return this.request<PTYSession | null>('get_session', { id })
  }

  async getSessionLog(id: string, options: { tail?: number } = {}): Promise<string | null> {
    const r = await this.request<{ log?: string }>('get_session_log', { id, ...options })
    return r?.log ?? null
  }

  async describeMissingSession(id: string): Promise<MissingSessionInfo | null> {
    return this.request<MissingSessionInfo | null>('describe_missing_session', { id })
  }

  async describeServer(): Promise<ServerDescription> {
    return this.request<ServerDescription>('describe_server')
  }

  async getRawBuffer(
    id: string,
    since?: number,
    budget?: number
  ): Promise<{ raw: string; byteLength: number; offset: number } | null> {
    return this.request<{ raw: string; byteLength: number; offset: number } | null>(
      'get_raw_buffer',
      { id, since, budget }
    )
  }

  async readSince(id: string, since: number, budget?: number): Promise<BoundedRawResult | null> {
    return this.request<BoundedRawResult | null>('read_since', { id, since, budget })
  }

  async cleanupBySession(parentSessionId: string): Promise<void> {
    await this.request('cleanup_by_session', { parentSessionId })
  }

  async loadPersistedSessions(): Promise<PersistedSession[]> {
    return this.request<PersistedSession[]>('load_persisted_sessions')
  }

  async bulkRemove(ids: string[]): Promise<BulkRemoveResult> {
    return this.request<BulkRemoveResult>('bulk_remove', { ids })
  }

  async restoreSessions(ids: string[]): Promise<RestoreSessionsResult> {
    return this.request<RestoreSessionsResult>('restore_sessions', { ids })
  }

  async clearAllSessions(): Promise<void> {
    await this.request('clear_all_sessions')
  }

  noteClientSize(cols: number, rows: number): void {
    this.request('note_client_size', { cols, rows }).catch(() => {})
  }

  async getSessionStore(): Promise<PtySessionStore> {
    return {
      getRetention: async () => {
        const r = await this.request<{ retention: RetentionPolicy }>('get_retention')
        return r.retention
      },
      updateRetention: async (policy) => {
        const r = await this.request<{ pruned: string[] }>('update_retention', { policy })
        return r.pruned
      },
      getGeneration: async () => {
        const r = await this.request<{ generation: string }>('get_generation')
        return r.generation
      },
      getRoot: async () => {
        const r = await this.request<{ stateDir: string }>('get_state_dir')
        return r.stateDir
      },
      list: async () => this.request<PersistedSession[]>('list_persisted'),
      read: async (id, offset, limit) =>
        this.request<BoundedReadResult | null>('read_persisted', { id, offset, limit }),
      isEnabled: async () => true,
      close: async () => {},
    }
  }

  async setSessionStore(_store: unknown): Promise<void> {
    // No-op on client side; daemon owns the store
  }
}
