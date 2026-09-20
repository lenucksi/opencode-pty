import type { SessionNotifier } from '../../adapters/types.ts'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { Terminal } from 'bun-pty'
import { NotificationManager } from './notification-manager.ts'
import { OutputManager } from './output-manager.ts'
import { logPtyEvent } from './plugin-log.ts'
import { mergePersistedSessions, type PersistSessionInput, SessionStore } from './session-store.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type { PTYSessionInfo, ReadResult, SearchResult, SpawnOptions } from './types.ts'
import { withSession } from './utils.ts'

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

class PTYManager {
  private lifecycleManager = new SessionLifecycleManager()
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

  spawn(opts: SpawnOptions): PTYSessionInfo {
    const session = this.lifecycleManager.spawn(
      opts,
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

  read(id: string, offset: number = 0, limit?: number): ReadResult | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.read(session, offset, limit),
      null
    )
    return live ?? this.sessionStore.read(id, offset, limit)
  }

  search(id: string, pattern: RegExp, offset: number = 0, limit?: number): SearchResult | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.search(session, pattern, offset, limit),
      null
    )
    return live ?? this.sessionStore.search(id, pattern, offset, limit)
  }

  list(): PTYSessionInfo[] {
    const live = this.lifecycleManager.listSessions().map((s) => this.lifecycleManager.toInfo(s))
    return mergePersistedSessions(live, this.sessionStore.list())
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

  /** Archived output as plain text, used by the log endpoint and `pty_read`. */
  getSessionLog(id: string, options: { tail?: number } = {}): string | null {
    const live = withSession(
      this.lifecycleManager,
      id,
      (session) => session.buffer.read(0).join('\n'),
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
  loadPersistedSessions(): PTYSessionInfo[] {
    return this.sessionStore.markStaleAsLost().map((entry) => {
      const [merged] = mergePersistedSessions([], [entry])
      return merged as PTYSessionInfo
    })
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
    return { raw, byteLength: new TextEncoder().encode(raw).length, offset: text.length }
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

  resize(id: string, cols: number, rows: number): boolean {
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
