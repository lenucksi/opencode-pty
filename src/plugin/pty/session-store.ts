import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { logPtyEvent } from './plugin-log.ts'
import { sessionsRoot } from './state-paths.ts'
import type { PTYSessionInfo, ReadResult, SearchResult } from './types.ts'

/** Everything worth keeping about a session, including who asked for it. */
export interface PersistSessionInput extends PTYSessionInfo {
  parentSessionId?: string
  parentAgent?: string
}

/** A session that only exists on disk now. */
export interface PersistedSession extends PersistSessionInput {
  archived: true
  generation: string
  endedAt?: string
  bytes: number
  truncated?: boolean
}

export interface RetentionPolicy {
  /** Newest sessions kept, older ones are pruned. */
  maxSessions: number
  /** Sessions older than this are pruned. */
  maxAgeDays: number
  /** Per session cap; beyond it the log rotates once and older output is dropped. */
  maxBytesPerSession: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxSessions: 200,
  maxAgeDays: 14,
  maxBytesPerSession: 5 * 1024 * 1024,
}

export interface SessionStoreOptions {
  root?: string
  generation?: string
  enabled?: boolean
  now?: () => number
  retention?: Partial<RetentionPolicy>
  flushIntervalMs?: number
  flushBytes?: number
}

const LOG_FILE = 'output.log'
const PREVIOUS_LOG_FILE = 'output.log.1'
const META_FILE = 'meta.json'
const INDEX_FILE = 'index.json'

function defaultRoot(): string {
  if (process.env.OPENCODE_PTY_STATE_DIR) return process.env.OPENCODE_PTY_STATE_DIR
  if (process.env.NODE_ENV === 'test') return join(tmpdir(), 'opencode-pty-test-state')
  return sessionsRoot()
}

function defaultGeneration(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Archived PTY sessions on disk.
 *
 * A session's output is appended as it arrives (buffered, then flushed) so a
 * crashed or restarted plugin still has the tail, and `meta.json` is written
 * atomically so a half-written file can never be read back. Everything lives
 * under the per-user state directory with `0700`/`0600` permissions: terminal
 * output regularly contains secrets.
 */
export class SessionStore {
  private readonly root: string
  private readonly generation: string
  private readonly now: () => number
  private readonly enabled: boolean
  private readonly retention: RetentionPolicy
  private readonly flushIntervalMs: number
  private readonly flushBytes: number
  private readonly pending = new Map<string, string>()
  private readonly bytesWritten = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private index: PersistedSession[] = []

  constructor(options: SessionStoreOptions = {}) {
    // Tests spawn real processes through the manager singleton; keep their
    // archives out of the developer's state directory.
    this.root = options.root ?? defaultRoot()
    this.now = options.now ?? Date.now
    this.generation = options.generation ?? defaultGeneration(this.now())
    this.enabled = options.enabled ?? process.env.OPENCODE_PTY_PERSIST !== '0'
    this.retention = { ...DEFAULT_RETENTION, ...options.retention }
    this.flushIntervalMs = options.flushIntervalMs ?? 250
    this.flushBytes = options.flushBytes ?? 8192

    if (!this.enabled) {
      return
    }

    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      this.loadIndex()
      this.prune()
    } catch (error) {
      logPtyEvent('error', 'session store is unavailable, sessions will not be archived', error)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getGeneration(): string {
    return this.generation
  }

  // ---------------------------------------------------------------- lifecycle

  startSession(info: PersistSessionInput): void {
    if (!this.enabled) return

    const entry: PersistedSession = {
      ...info,
      archived: true,
      generation: this.generation,
      bytes: 0,
    }

    try {
      mkdirSync(this.sessionDir(info.id), { recursive: true, mode: 0o700 })
      this.writeMeta(entry)
      this.upsertIndex(entry)
    } catch (error) {
      logPtyEvent('error', `failed to archive session ${info.id}`, error)
    }
  }

  appendOutput(id: string, chunk: string): void {
    if (!this.enabled || chunk.length === 0) return

    this.pending.set(id, (this.pending.get(id) ?? '') + chunk)

    const buffered = this.pending.get(id) ?? ''
    if (buffered.length >= this.flushBytes) {
      this.flushSession(id)
      return
    }

    this.ensureFlushTimer()
  }

  endSession(info: PersistSessionInput, exitCode: number | null): void {
    if (!this.enabled) return

    this.flushSession(info.id)
    const existing = this.index.find((entry) => entry.id === info.id)
    const entry: PersistedSession = {
      ...info,
      // The parent link is recorded at spawn time; the exit info usually does
      // not repeat it, and later notices still need to find the session.
      ...(info.parentSessionId === undefined && existing?.parentSessionId !== undefined
        ? { parentSessionId: existing.parentSessionId }
        : {}),
      ...(info.parentAgent === undefined && existing?.parentAgent !== undefined
        ? { parentAgent: existing.parentAgent }
        : {}),
      archived: true,
      generation: existing?.generation ?? this.generation,
      bytes: this.bytesWritten.get(info.id) ?? existing?.bytes ?? 0,
      endedAt: new Date(this.now()).toISOString(),
      ...(exitCode === null ? {} : { exitCode }),
      ...(existing?.truncated ? { truncated: true } : {}),
    }

    try {
      this.writeMeta(entry)
      this.upsertIndex(entry)
    } catch (error) {
      logPtyEvent('error', `failed to finalise archived session ${info.id}`, error)
    }
  }

  /** Sessions that were still running when the previous instance stopped. */
  markStaleAsLost(): PersistedSession[] {
    if (!this.enabled) return []

    const lost: PersistedSession[] = []
    for (const entry of this.index) {
      if (entry.status !== 'running' && entry.status !== 'killing') continue

      entry.status = 'exited'
      entry.lost = true
      entry.endedAt = new Date(this.now()).toISOString()
      lost.push(entry)
      try {
        this.writeMeta(entry)
      } catch (error) {
        logPtyEvent('error', `failed to mark session ${entry.id} as lost`, error)
      }
    }

    if (lost.length > 0) {
      this.saveIndex()
      logPtyEvent('warn', `marked ${lost.length} session(s) as lost after a restart`, {
        ids: lost.map((entry) => entry.id),
      })
    }

    return lost
  }

  flush(): void {
    for (const id of [...this.pending.keys()]) {
      this.flushSession(id)
    }
  }

  close(): void {
    this.flush()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ------------------------------------------------------------------ reading

  list(): PersistedSession[] {
    return [...this.index].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): PersistedSession | null {
    return this.index.find((entry) => entry.id === id) ?? null
  }

  read(id: string, offset = 0, limit?: number): ReadResult | null {
    const lines = this.lines(id)
    if (lines === null) return null

    const start = Math.max(0, Math.floor(offset))
    const slice =
      limit === undefined ? lines.slice(start) : lines.slice(start, start + Math.max(0, limit))

    return {
      lines: slice,
      totalLines: lines.length,
      offset: start,
      hasMore: start + slice.length < lines.length,
    }
  }

  search(id: string, pattern: RegExp, offset = 0, limit?: number): SearchResult | null {
    const lines = this.lines(id)
    if (lines === null) return null

    const allMatches = lines
      .map((text, index) => ({ lineNumber: index + 1, text }))
      .filter((match) => pattern.test(match.text))

    const start = Math.max(0, Math.floor(offset))
    const matches =
      limit === undefined
        ? allMatches.slice(start)
        : allMatches.slice(start, start + Math.max(0, limit))

    return {
      matches,
      totalMatches: allMatches.length,
      totalLines: lines.length,
      offset: start,
      hasMore: start + matches.length < allMatches.length,
    }
  }

  /** All archived lines, or null when the session is unknown. */
  private lines(id: string): string[] | null {
    const raw = this.readRaw(id)
    if (raw === null) return null

    const lines = raw.length === 0 ? [] : raw.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
  }

  readRaw(id: string): string | null {
    if (!existsSync(this.sessionDir(id))) return null

    let text = ''
    for (const file of [PREVIOUS_LOG_FILE, LOG_FILE]) {
      const path = join(this.sessionDir(id), file)
      try {
        if (existsSync(path)) text += readFileSync(path, 'utf8')
      } catch (error) {
        logPtyEvent('warn', `failed to read archived output of ${id}`, error)
      }
    }
    return text
  }

  // ------------------------------------------------------------------ cleanup

  remove(id: string): boolean {
    if (!this.enabled) return false

    const known = this.index.some((entry) => entry.id === id)
    try {
      rmSync(this.sessionDir(id), { recursive: true, force: true })
    } catch (error) {
      logPtyEvent('error', `failed to remove archived session ${id}`, error)
      return false
    }

    if (known) {
      this.index = this.index.filter((entry) => entry.id !== id)
      this.saveIndex()
    }
    this.pending.delete(id)
    this.bytesWritten.delete(id)
    return known
  }

  clear(): number {
    const ids = this.index.map((entry) => entry.id)
    for (const id of ids) {
      this.remove(id)
    }
    return ids.length
  }

  prune(): string[] {
    if (!this.enabled) return []

    const removed: string[] = []
    const cutoff = this.now() - this.retention.maxAgeDays * 24 * 60 * 60 * 1000

    for (const entry of this.list()) {
      // A session that never finished is marked lost at startup and pruned
      // afterwards; removing its directory while output may still be appended
      // would only leave a half archive behind.
      if (entry.status === 'running' || entry.status === 'killing') continue

      const ended = entry.endedAt ? Date.parse(entry.endedAt) : Number.NaN
      const created = Date.parse(entry.createdAt)
      const reference = Number.isNaN(ended) ? created : ended
      if (Number.isFinite(reference) && reference < cutoff) {
        if (this.remove(entry.id)) removed.push(entry.id)
      }
    }

    for (const entry of this.list().slice(this.retention.maxSessions)) {
      if (this.remove(entry.id)) removed.push(entry.id)
    }

    if (removed.length > 0) {
      logPtyEvent('info', `pruned ${removed.length} archived session(s)`, { ids: removed })
    }
    return removed
  }

  // ------------------------------------------------------------------ private

  private sessionDir(id: string): string {
    return join(this.root, id)
  }

  private ensureFlushTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.flush()
      if (this.pending.size === 0 && this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    }, this.flushIntervalMs)
    // Never keep the process alive just to flush a log.
    this.timer.unref?.()
  }

  private flushSession(id: string): void {
    const chunk = this.pending.get(id)
    if (chunk === undefined || chunk.length === 0) return
    this.pending.delete(id)

    const dir = this.sessionDir(id)
    const path = join(dir, LOG_FILE)
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }

      const written = this.bytesWritten.get(id) ?? this.fileSize(path)
      if (written + chunk.length > this.retention.maxBytesPerSession) {
        // Rotate once: the newest output is what matters, and the tail is what
        // a reader (or a post-restart `<pty_restart>` notice) needs.
        renameSync(path, join(dir, PREVIOUS_LOG_FILE))
        this.bytesWritten.set(id, 0)
        this.markTruncated(id)
      }

      appendFileSync(path, chunk, { mode: 0o600 })
      this.bytesWritten.set(id, (this.bytesWritten.get(id) ?? 0) + chunk.length)
    } catch (error) {
      logPtyEvent('error', `failed to append output for ${id}`, error)
    }
  }

  private fileSize(path: string): number {
    try {
      return existsSync(path) ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

  private markTruncated(id: string): void {
    const entry = this.index.find((item) => item.id === id)
    if (!entry || entry.truncated) return

    entry.truncated = true
    try {
      this.writeMeta(entry)
      this.saveIndex()
    } catch (error) {
      logPtyEvent('warn', `failed to record truncation for ${id}`, error)
    }
  }

  private writeMeta(entry: PersistedSession): void {
    const path = join(this.sessionDir(entry.id), META_FILE)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(entry, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  }

  private loadIndex(): void {
    const path = join(this.root, INDEX_FILE)
    try {
      if (!existsSync(path)) return
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      this.index = Array.isArray(parsed) ? (parsed as PersistedSession[]) : []
    } catch (error) {
      logPtyEvent('warn', 'archived session index is unreadable, starting fresh', error)
      this.index = []
    }
  }

  private saveIndex(): void {
    const path = join(this.root, INDEX_FILE)
    const temporary = `${path}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(this.index, null, 2), { mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      logPtyEvent('error', 'failed to write the archived session index', error)
    }
  }

  private upsertIndex(entry: PersistedSession): void {
    const index = this.index.findIndex((item) => item.id === entry.id)
    if (index >= 0) {
      this.index[index] = entry
    } else {
      this.index.push(entry)
    }
    this.saveIndex()
  }
}

/**
 * Live sessions win over their archived copy; archived-only sessions are added
 * so a restart does not make history disappear from listings.
 */
export function mergePersistedSessions(
  live: PTYSessionInfo[],
  persisted: PersistedSession[]
): PTYSessionInfo[] {
  const liveIds = new Set(live.map((session) => session.id))
  const archived = persisted
    .filter((entry) => !liveIds.has(entry.id))
    .map<PTYSessionInfo>((entry) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      command: entry.command,
      args: entry.args,
      workdir: entry.workdir,
      status: entry.status,
      notifyOnExit: entry.notifyOnExit,
      ...(entry.timeoutSeconds === undefined ? {} : { timeoutSeconds: entry.timeoutSeconds }),
      timedOut: entry.timedOut,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.exitSignal === undefined ? {} : { exitSignal: entry.exitSignal }),
      pid: entry.pid,
      createdAt: entry.createdAt,
      lineCount: entry.lineCount,
      archived: true,
      ...(entry.lost ? { lost: true } : {}),
    }))

  return [...live, ...archived]
}
