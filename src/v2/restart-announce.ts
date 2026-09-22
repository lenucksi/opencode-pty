import type { SessionNotifier } from '../adapters/types.ts'
import { logPtyEvent } from '../plugin/pty/plugin-log.ts'
import {
  buildRestartNotice,
  readAnnouncedGeneration,
  writeAnnouncedGeneration,
} from '../plugin/pty/restart-notice.ts'
import type { PersistedSession, SessionStore } from '../plugin/pty/session-store.ts'
import { normalizeLogText } from '../web/shared/log-format.ts'

export interface AnnounceRestartOptions {
  store: SessionStore
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

  const generation = options.store.getGeneration()
  const root = options.store.getRoot()
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
  const archivedCount = options.store.list().length

  for (const [parentSessionId, sessions] of targets) {
    const [first] = sessions
    if (!first) continue

    const text = buildRestartNotice({
      generation,
      startedAt: new Date(now()).toISOString(),
      ...(options.webUrl ? { webUrl: options.webUrl } : {}),
      ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
      lost: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.lost ? `${session.status} (lost)` : session.status,
        lineCount: session.lineCount,
        tail: normalizeLogText(
          options.store.read(session.id, 0, 5)?.lines.join('\n') ?? '',
          'plain'
        ),
      })),
      archivedCount,
      persistEnabled: options.store.isEnabled(),
      retention: options.store.getRetention(),
    })

    await notifier.sendNotice({ id: first.id, parentSessionId }, text, 'restart')
  }

  writeAnnouncedGeneration(root, generation, logPtyEvent)
  logPtyEvent('info', `restart notice sent to ${targets.size} session(s)`, {
    lost: lost.map((session) => session.id),
  })
}
