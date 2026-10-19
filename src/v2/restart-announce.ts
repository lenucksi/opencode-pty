import type { SessionNotifier } from '../adapters/types.ts'
import { logPtyEvent } from '../plugin/pty/plugin-log.ts'
import {
  buildRestartNotice,
  readAnnouncedGeneration,
  writeAnnouncedGeneration,
} from '../plugin/pty/restart-notice.ts'
import type { BoundedReadResult } from '../plugin/pty/output-manager.ts'
import type {
  PersistedSession,
  RetentionPolicy,
  SessionStore,
} from '../plugin/pty/session-store.ts'
import { normalizeLogText } from '../web/shared/log-format.ts'

/**
 * The store this announcement reads from.
 *
 * Either return type is accepted, because the caller may hold a daemon client whose
 * store speaks over a socket. `SessionStore` stays assignable unchanged: a synchronous
 * method is a valid `T | Promise<T>`.
 */
export interface RestartStore {
  getGeneration(): string | Promise<string>
  getRoot(): string | Promise<string>
  list(): PersistedSession[] | Promise<PersistedSession[]>
  read(
    id: string,
    offset: number,
    limit: number
  ): BoundedReadResult | null | Promise<BoundedReadResult | null>
  isEnabled(): boolean | Promise<boolean>
  getRetention(): RetentionPolicy | Promise<RetentionPolicy>
}

export interface AnnounceRestartOptions {
  store: SessionStore | RestartStore
  notifier?: SessionNotifier
  restored: PersistedSession[]
  webUrl?: string
  hostVersion?: string
  now?: () => number
}

/**
 * Tell the sessions that owned a lost PTY that the server restarted.
 *
 * Only sessions that were still running when the previous instance stopped are
 * announced, and only once per boot: the generation is written to a marker file
 * so a second plugin setup (several locations load the plugin) does not wake
 * anyone twice.
 */
export async function announceRestart(options: AnnounceRestartOptions): Promise<void> {
  const lost = options.restored.filter((session) => session.lost)
  if (lost.length === 0) return

  const generation = await options.store.getGeneration()
  const root = await options.store.getRoot()
  if (readAnnouncedGeneration(root) === generation) return

  const targets = new Map<string, PersistedSession[]>()
  for (const session of lost) {
    if (!session.parentSessionId) continue
    const existing = targets.get(session.parentSessionId) ?? []
    existing.push(session)
    targets.set(session.parentSessionId, existing)
  }

  const notifier = options.notifier
  if (!notifier?.sendNotice || targets.size === 0) {
    logPtyEvent(
      'warn',
      `restart notice not delivered: ${
        notifier?.sendNotice ? 'no parent session to notify' : 'notifier does not support notices'
      }`,
      { lost: lost.map((session) => session.id) }
    )
    writeAnnouncedGeneration(root, generation, logPtyEvent)
    return
  }

  const now = options.now ?? Date.now
  const archivedCount = (await options.store.list()).length

  for (const [parentSessionId, sessions] of targets) {
    const [first] = sessions
    if (!first) continue

    // One read per lost session, in parallel: the store may be a daemon client, and
    // a map callback cannot await.
    const lostRows = await Promise.all(
      sessions.map(async (session) => ({
        id: session.id,
        title: session.title,
        status: session.lost ? `${session.status} (lost)` : session.status,
        lineCount: session.lineCount,
        tail: normalizeLogText(
          (await options.store.read(session.id, 0, 5))?.lines.join('\n') ?? '',
          'plain'
        ),
      }))
    )
    const text = buildRestartNotice({
      generation,
      startedAt: new Date(now()).toISOString(),
      ...(options.webUrl ? { webUrl: options.webUrl } : {}),
      ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
      lost: lostRows,
      archivedCount,
      persistEnabled: await options.store.isEnabled(),
      retention: await options.store.getRetention(),
    })

    await notifier.sendNotice({ id: first.id, parentSessionId }, text, 'restart')
  }

  writeAnnouncedGeneration(root, generation, logPtyEvent)
  logPtyEvent('info', `restart notice sent to ${targets.size} session(s)`, {
    lost: lost.map((session) => session.id),
  })
}
