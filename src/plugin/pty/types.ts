import type { IPty } from 'bun-pty'
import type { RingBuffer } from './buffer.ts'

export type PTYStatus = 'running' | 'exited' | 'killing' | 'killed'

/**
 * What a bulk removal did, per id.
 *
 * The three buckets are separate because the human has to be told which is
 * which *before* the call, and "removed 205 sessions" cannot say that 204 can be
 * taken back and one cannot.
 */
export interface BulkRemoveResult {
  /** Moved to the trash. Every one of these can be restored. */
  removed: string[]
  /** Still running, so stopped. Their buffer was cleared, never archived. */
  killed: string[]
  /** Matched no session. */
  failed: string[]
}

/** What a restore did, per id. */
export interface RestoreSessionsResult {
  /** Back on disk and in the list. */
  restored: string[]
  /** No longer in the trash: never removed, or the trash was emptied. */
  failed: string[]
}

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
  /**
   * Size the process was started with, and the size it has since been resized to.
   *
   * Recorded rather than inferred, because the alternative was a size nobody
   * could read back: the agent had no way to learn what geometry a TUI was being
   * given, so it could not tell a cramped program from a broken one.
   */
  cols: number
  rows: number
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
   * Current terminal geometry.
   *
   * A program that formats for 80 columns but is given 40 wraps in the wrong
   * places, and nothing in the output says why. Reporting the size makes that
   * diagnosable from `pty_list` alone.
   */
  cols: number
  rows: number
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
  /** Terminal columns to start with; defaults to the last size a client reported. */
  cols?: number
  /** Terminal rows to start with; defaults to the last size a client reported. */
  rows?: number
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
