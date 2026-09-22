import type { PTYSessionInfo } from './types.ts'

/** Local wall-clock time with seconds; empty for a missing or invalid value. */
export function formatClock(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

/** Compact duration: `42s`, `18m`, `2h 04m`, `1d 3h`. */
export function formatDuration(startIso: string, endIso?: string): string {
  const start = Date.parse(startIso)
  const end = endIso === undefined ? Date.now() : Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''

  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The command that was actually started, arguments included. */
export function sessionCommandLine(session: PTYSessionInfo): string {
  return [session.command, ...session.args].join(' ').trim()
}

/**
 * One-line timing summary: while a session runs it shows when it started and
 * how long it has been going, afterwards the start, end and total duration.
 */
export function sessionTiming(session: PTYSessionInfo): string {
  const started = formatClock(session.createdAt)
  const isLive = session.status === 'running' || session.status === 'killing'

  if (isLive) {
    const runningFor = formatDuration(session.createdAt)
    return [started ? `started ${started}` : '', runningFor ? `running ${runningFor}` : '']
      .filter(Boolean)
      .join(' · ')
  }

  const ended = formatClock(session.endedAt)
  const duration =
    session.endedAt === undefined ? '' : formatDuration(session.createdAt, session.endedAt)
  return [started ? `started ${started}` : '', ended ? `ended ${ended}` : '', duration]
    .filter(Boolean)
    .join(' · ')
}

/** Hover text with the details that do not fit on one line. */
export function sessionTooltip(session: PTYSessionInfo): string {
  return [session.id, sessionCommandLine(session), `workdir: ${session.workdir}`]
    .filter((line) => line.trim() !== '')
    .join('\n')
}

/** Everything worth showing about a session on one line (`pty_list`-style). */
export function sessionDetailLine(session: PTYSessionInfo): string {
  return [
    `PID ${session.pid}`,
    sessionTiming(session),
    sessionCommandLine(session),
    `${session.lineCount} lines`,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/**
 * Newest activity first.
 *
 * A finished session is ordered by when it ended (a long-running one that just
 * exited should not sink below one that started later but ended earlier), a
 * running one by its start time. Stable for equal timestamps. Shared by the
 * server (list responses) and the client (WebSocket updates), so both agree.
 */
export function sortSessionsByTime(sessions: PTYSessionInfo[]): PTYSessionInfo[] {
  const activity = (session: PTYSessionInfo): number =>
    Date.parse(session.endedAt ?? session.createdAt) || 0

  return [...sessions].sort(
    (a, b) =>
      activity(b) - activity(a) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id)
  )
}

/**
 * The sidebar has ~300 px: everything except the line count, so the timings
 * stay visible. The line count and the full command live in the tooltip (and
 * in the terminal header).
 */
export function sessionSidebarMeta(session: PTYSessionInfo): string {
  return [`PID ${session.pid}`, sessionTiming(session)].filter((part) => part !== '').join(' · ')
}
