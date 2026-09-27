import type { SessionNotifier } from '../../adapters/types.ts'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { Terminal } from 'bun-pty'
import { FALLBACK_TERMINAL_COLS, FALLBACK_TERMINAL_ROWS } from '../constants.ts'
import { NotificationManager } from './notification-manager.ts'
import {
  OutputManager,
  type BoundedReadResult,
  type BoundedSearchResult,
} from './output-manager.ts'
import { sortSessionsByTime } from '../../web/shared/session-meta.ts'
import { logPtyEvent } from './plugin-log.ts'
import {
  mergePersistedSessions,
  type PersistedSession,
  type PersistSessionInput,
  SessionStore,
} from './session-store.ts'
import { buildBoundedRaw, type BoundedRawResult } from './read-budget.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type { PTYSession, PTYSessionInfo, SpawnOptions } from './types.ts'
import { withSession } from './utils.ts'

/** Details about a session that is only left on disk. */
export interface MissingSessionInfo {
  id: string
  archived: true
  generation: string
  status: string
  lineCount: number
  lost?: boolean
  tail: string
}

/** Compact "which boot am I talking to" header for tool results and the API. */
export interface ServerDescription {
  generation: string
  sessions: number
  running: number
  archived: number
  persist: boolean
}

type StartReadLoop = (this: InstanceType<typeof Terminal>, ...args: unknown[]) => unknown

const proto = Terminal.prototype
// `_startReadLoop` is a private method, so reach it through Reflect and treat
// it as the typed shim below rather than asserting the whole prototype shape.
const original = Reflect.get(proto, '_startReadLoop') as StartReadLoop | undefined

if (typeof original === 'function') {
  Reflect.set(
    proto,
    '_startReadLoop',
    async function (this: InstanceType<typeof Terminal>, ...args: unknown[]) {
      await Promise.resolve() // Yield to allow event handlers to be registered
      return original.apply(this, args)
    }
  )
}

type SessionUpdateCallback = (session: PTYSessionInfo) => void

export const sessionUpdateCallbacks: SessionUpdateCallback[] = []

export function registerSessionUpdateCallback(callback: SessionUpdateCallback) {
  sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback) {
  const index = sessionUpdateCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionUpdateCallbacks.splice(index, 1)
  }
}

function notifySessionUpdate(session: PTYSessionInfo) {
  for (const callback of [...sessionUpdateCallbacks]) {
    try {
      callback(session)
    } catch {
      // Ignore callback errors
    }
  }
}

type RawOutputCallback = (sessionId: string, rawData: string, offset: number) => void

export const rawOutputCallbacks: RawOutputCallback[] = []

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const index = rawOutputCallbacks.indexOf(callback)
  if (index !== -1) {
    rawOutputCallbacks.splice(index, 1)
  }
}

function notifyRawOutput(sessionId: string, rawData: string, offset: number): void {
  for (const callback of rawOutputCallbacks) {
    try {
      callback(sessionId, rawData, offset)
    } catch {
      // Ignore callback errors
    }
  }
}

type SessionRemovedCallback = (sessionId: string) => void

export const sessionRemovedCallbacks: SessionRemovedCallback[] = []

export function registerSessionRemovedCallback(callback: SessionRemovedCallback): void {
  sessionRemovedCallbacks.push(callback)
}

export function removeSessionRemovedCallback(callback: SessionRemovedCallback): void {
  const index = sessionRemovedCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionRemovedCallbacks.splice(index, 1)
  }
}

function notifySessionRemoved(sessionId: string): void {
  for (const callback of sessionRemovedCallbacks) {
    try {
      callback(sessionId)
    } catch {
      // Ignore callback errors
    }
  }
}

export class PTYManager {
  private lifecycleManager = new SessionLifecycleManager()
  /**
   * Terminal size a connected web client last reported, if any.
   *
   * Remembered so a later agent-spawned session inherits the geometry the human
   * is actually looking at, instead of an arbitrary constant. Deliberately not
   * written by `pty_resize`: an agent changing one session's size says nothing
   * about the size of the human's window.
   */
  private lastClientSize: { cols: number; rows: number } | null = null

  /** Record the size a web client's terminal pane is using. */
  noteClientSize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.lastClientSize = { cols: Math.floor(cols), rows: Math.floor(rows) }
  }

  /** The size a new session would get right now, or null when nothing is known. */
  clientSize(): { cols: number; rows: number } | null {
    return this.lastClientSize
  }

  private outputManager = new OutputManager()
  private notificationManager = new NotificationManager()
  private notifier: SessionNotifier | null = null
  private sessionStore = new SessionStore()

  setNotifier(notifier: SessionNotifier | null): void {
    this.notifier = notifier
  }

  getNotifier(): SessionNotifier | null {
    return this.notifier ?? this.notificationManager
  }

  init(client: OpencodeClient): void {
    this.notificationManager.init(client)
    this.notifier = this.notificationManager
  }

  clearAllSessions(): void {
    const removedIds = this.lifecycleManager.listSessions().map((session) => session.id)
    this.lifecycleManager.clearAllSessions()
    this.sessionStore.clear()
    for (const id of removedIds) {
      notifySessionRemoved(id)
    }
  }

  /**
   * Start a session, giving it a terminal size it can actually work in.
   *
   * The size a web client last reported wins, because that is the only honest
   * answer to "how wide would this run": it is the geometry a human is looking
   * at right now. A spawn with no client attached falls back to a wide, tall
   * default rather than the old 120x40, which made anything that formats a table
   * or draws a full-screen UI look broken.
   *
   * An explicit `cols`/`rows` on the call always wins over both.
   */
  spawn(opts: SpawnOptions): PTYSessionInfo {
    const fallback = this.lastClientSize ?? {
      cols: FALLBACK_TERMINAL_COLS,
      rows: FALLBACK_TERMINAL_ROWS,
    }
    const session = this.lifecycleManager.spawn(
      {
        ...opts,
        cols: opts.cols ?? fallback.cols,
        rows: opts.rows ?? fallback.rows,
      },
      (session, data, offset) => {
        this.sessionStore.appendOutput(session.id, data)
        notifyRawOutput(session.id, data, offset)
      },
      async (session, exitCode) => {
        const info = this.lifecycleManager.toInfo(session)
        this.sessionStore.endSession(this.persistInput(info, session), exitCode)
        notifySessionUpdate(info)
        if (session?.notifyOnExit) {
          const activeNotifier = this.notifier ?? this.notificationManager
          logPtyEvent('info', `delivering exit notification for ${session.id}`, {
            notifier: activeNotifier.constructor?.name ?? typeof activeNotifier,
            exitCode,
          })
          await activeNotifier.sendExitNotification(session, exitCode || 0)
        }
      }
    )
    this.sessionStore.startSession(this.persistInput(session, opts))
    notifySessionUpdate(session)
    return session
  }

  write(id: string, data: string): boolean {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.write(session, data),
      false
    )
  }

  read(id: string, offset: number = 0, limit?: number, budget?: number): BoundedReadResult | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.read(session, offset, limit, budget),
      null
    )
    return live ?? this.sessionStore.read(id, offset, limit)
  }

  search(
    id: string,
    pattern: RegExp,
    offset: number = 0,
    limit?: number,
    budget?: number
  ): BoundedSearchResult | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.search(session, pattern, offset, limit, budget),
      null
    )
    return live ?? this.sessionStore.search(id, pattern, offset, limit)
  }

  list(): PTYSessionInfo[] {
    const live = this.lifecycleManager.listSessions().map((s) => this.lifecycleManager.toInfo(s))
    return sortSessionsByTime(mergePersistedSessions(live, this.sessionStore.list()))
  }

  /**
   * The live session object, including the PTY handle and the buffer.
   *
   * `get` returns the serialisable view, which is what most callers want. This is
   * for the ones that need something the view cannot carry: the running process
   * itself, the screen state, the buffer object. Returns null for an unknown or
   * already-archived id rather than reaching into the store, because an archived
   * transcript has no live process to inspect.
   */
  getSession(id: string): PTYSession | null {
    return withSession(this.lifecycleManager, id, (session) => session, null)
  }

  get(id: string): PTYSessionInfo | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => this.lifecycleManager.toInfo(session),
      null
    )
    if (live) return live

    const archived = this.sessionStore.get(id)
    if (!archived) return null
    const [merged] = mergePersistedSessions([], [archived])
    return merged ?? null
  }

  /**
   * Transcript of a session exactly as it was emitted (control characters
   * included), live or from the archive. Callers normalise as they need.
   */
  getSessionLog(id: string, options: { tail?: number } = {}): string | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => session.buffer.sliceSince(0).raw,
      null
    )
    const raw = live ?? this.sessionStore.readRaw(id)
    if (raw === null) return null
    if (options.tail === undefined) return raw

    const lines = raw.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.slice(Math.max(0, lines.length - options.tail)).join('\n')
  }

  /** Archive entries restored at startup, marked lost if they were running. */
  loadPersistedSessions(): PersistedSession[] {
    return this.sessionStore.markStaleAsLost()
  }

  /**
   * What a caller needs when a session id is unknown: whether it exists in the
   * archive, which boot owned it, and its last output.
   */
  describeMissingSession(id: string): MissingSessionInfo | null {
    const archived = this.sessionStore.get(id)
    if (!archived) return null

    return {
      id,
      archived: true,
      generation: archived.generation,
      status: archived.status,
      lineCount: archived.lineCount,
      ...(archived.lost ? { lost: true } : {}),
      tail: this.getSessionLog(id, { tail: 5 }) ?? '',
    }
  }

  /** Orientation for tool results: which boot this is and what is on disk. */
  describeServer(): ServerDescription {
    const sessions = this.list()
    return {
      generation: this.sessionStore.getGeneration(),
      sessions: sessions.length,
      running: sessions.filter((session) => session.status === 'running').length,
      archived: sessions.filter((session) => session.archived).length,
      persist: this.sessionStore.isEnabled(),
    }
  }

  /** Session info plus the fields the archive needs to reach the parent later. */
  private persistInput(
    info: PTYSessionInfo,
    parent: { parentSessionId?: string; parentAgent?: string }
  ): PersistSessionInput {
    return {
      ...info,
      ...(parent.parentSessionId === undefined ? {} : { parentSessionId: parent.parentSessionId }),
      ...(parent.parentAgent === undefined ? {} : { parentAgent: parent.parentAgent }),
    }
  }

  setSessionStore(store: SessionStore): void {
    this.sessionStore.close()
    this.sessionStore = store
  }

  getSessionStore(): SessionStore {
    return this.sessionStore
  }

  /**
   * Return the raw buffer suffix starting at `since`. `byteLength` is the real
   * UTF-8 byte length of `raw` (not the UTF-16 code-unit count), matching the
   * plain-buffer endpoint.
   */
  getRawBuffer(
    id: string,
    since?: number
  ): { raw: string; byteLength: number; offset: number } | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => {
        const { raw, offset } = session.buffer.sliceSince(since ?? 0)
        return {
          raw,
          byteLength: new TextEncoder().encode(raw).length,
          offset,
        }
      },
      null
    )

    if (live) return live

    const text = this.sessionStore.readRaw(id)
    if (text === null) return null
    const from = Math.min(Math.max(0, since ?? 0), text.length)
    const raw = text.slice(from)
    // The archived branch used to report the *end* of the transcript as the
    // offset while the live branch reported the *start* of the slice. Callers
    // that treat `offset` as a resume cursor silently jumped to the end of every
    // archived session.
    return { raw, byteLength: new TextEncoder().encode(raw).length, offset: from }
  }

  /**
   * Raw character stream from an absolute offset, bounded by a character budget.
   *
   * This is the paging primitive that makes a cut line recoverable. Line-based
   * `offset`/`limit` cannot resume inside a line that was cut, so a long line
   * either had to be re-read from its start or lost. Following `nextSince` here
   * re-assembles the original stream exactly, character for character.
   *
   * Offsets are **characters**, matching `RingBuffer`'s internal accounting, not
   * UTF-8 bytes. The two diverge on any non-ASCII output, which is common in
   * box-drawing and emoji-heavy TUIs.
   */
  readSince(id: string, since: number, budget?: number): BoundedRawResult | null {
    const from = Math.max(0, Math.floor(since))
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => {
        const { raw, offset } = session.buffer.sliceSince(from)
        return buildBoundedRaw(raw, offset, budget)
      },
      null
    )
    if (live) return live

    const text = this.sessionStore.readRaw(id)
    if (text === null) return null
    const start = Math.min(from, text.length)
    return buildBoundedRaw(text.slice(start), start, budget)
  }

  kill(id: string, cleanup: boolean = false): boolean {
    const success = this.lifecycleManager.kill(id, cleanup)
    if (!success) {
      // Not live (anymore), but maybe archived: removing it there is what makes
      // it disappear from the UI for good.
      const removedArchive = this.sessionStore.remove(id)
      if (removedArchive) notifySessionRemoved(id)
      return removedArchive
    }
    if (cleanup) {
      this.sessionStore.remove(id)
      notifySessionRemoved(id)
    }
    return success
  }

  resize(id: string, cols?: number, rows?: number): boolean {
    return this.lifecycleManager.resize(id, cols, rows)
  }

  cleanupBySession(parentSessionId: string): void {
    const removedIds = this.lifecycleManager
      .listSessions()
      .filter((session) => session.parentSessionId === parentSessionId)
      .map((session) => session.id)
    this.lifecycleManager.cleanupBySession(parentSessionId)
    for (const id of removedIds) {
      notifySessionRemoved(id)
    }
    for (const entry of this.sessionStore.list()) {
      if (entry.parentSessionId === parentSessionId && this.sessionStore.remove(entry.id)) {
        notifySessionRemoved(entry.id)
      }
    }
  }
}

export const manager = new PTYManager()

export function initManager(opcClient: OpencodeClient): void {
  manager.init(opcClient)
}

export function setManagerNotifier(notifier: SessionNotifier | null): void {
  manager.setNotifier(notifier)
}
