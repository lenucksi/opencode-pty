import type { IPty } from 'bun-pty'
import type { RingBuffer } from './buffer.ts'

export type PTYStatus = 'running' | 'exited' | 'killing' | 'killed'

export interface PTYSession {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  env?: Record<string, string>
  status: PTYStatus
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: Date
  /** Set when the process ends (exit or kill). */
  endedAt?: Date
  parentSessionId: string
  parentAgent?: string
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  buffer: RingBuffer
  process: IPty | null
}

export interface PTYSessionInfo {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  status: PTYStatus
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: string
  /** OpenCode session that requested this PTY; absent in legacy archive rows. */
  parentSessionId?: string
  /** Agent active in the requesting session when the PTY was spawned. */
  parentAgent?: string
  /** ISO timestamp of the end, when the session is no longer running. */
  endedAt?: string
  lineCount: number
  /**
   * Characters currently retained in the buffer.
   *
   * A line count alone is misleading: a full-screen TUI repaints as a single
   * line of escape sequences, so an 85 kB screen reports `lineCount: 1`. This is
   * what makes such a stream diagnosable from `pty_list` alone.
   */
  charCount: number
  /**
   * Session read back from the on-disk store after its process (and the plugin
   * that owned it) is gone. `lost` marks one that was still running when the
   * previous instance stopped.
   */
  archived?: boolean
  lost?: boolean
}

export interface SpawnOptions {
  command: string
  args?: string[]
  workdir?: string
  env?: Record<string, string>
  title?: string
  description?: string
  parentSessionId: string
  parentAgent?: string
  notifyOnExit?: boolean
  timeoutSeconds?: number
}

export interface ReadResult {
  lines: string[]
  totalLines: number
  offset: number
  hasMore: boolean
}

export interface SearchResult {
  matches: Array<{ lineNumber: number; text: string }>
  totalMatches: number
  totalLines: number
  offset: number
  hasMore: boolean
}
