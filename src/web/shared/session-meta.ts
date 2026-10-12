import { WEB_API_PARENT_SESSION_ID } from '../../plugin/constants.ts'
import type { PTYSessionInfo } from './types.ts'

export interface PTYSessionGroup<T = PTYSessionInfo> {
  /** Stable React/group key; the empty key represents legacy ungrouped rows. */
  key: string
  parentSessionId?: string
  parentAgent?: string
  sessions: T[]
}

/**
 * What grouping reads off a session, and nothing else.
 *
 * Same reason `TimeOrdered` is a constraint rather than a concrete parameter: the rule
 * belongs to a LIST, and the sidebar panel carries a trimmed session shape. Every web
 * caller passes a full `PTYSessionInfo`, so nothing there changes.
 */
export interface ParentGrouped extends TimeOrdered {
  readonly parentSessionId?: string
  readonly parentAgent?: string
}

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

/**
 * How precisely a duration is written.
 *
 * Two surfaces with very different room, so two presets out of ONE implementation: a
 * re-implementation per surface is how a 90-second build ends up reading `1m 30s` in
 * one place and `2m` in another, with nobody having decided either.
 */
export type DurationPrecision =
  /** `42s`, `18m`, `2h 04m`, `1d 3h` - one unit. For the web sidebar, which has room. */
  | 'compact'
  /**
   * `5s`, `1m 05s`, `2h 07m` - seconds kept below the hour, never days.
   *
   * For a 40-column sidebar: a run under an hour is usually worth naming to the
   * second, and a two-day run is a forgotten process rather than a measurement.
   */
  | 'precise'

/**
 * A run's length, from its start to its end.
 *
 * The `precise` preset needs no second implementation; it needs the seconds the
 * compact form drops, so both come out of the same arithmetic and cannot drift.
 */
export function formatDuration(
  startIso: string,
  endIso?: string,
  precision: DurationPrecision = 'compact'
): string {
  const start = Date.parse(startIso)
  const end = endIso === undefined ? Date.now() : Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  return formatDurationMs(end - start, precision)
}

/**
 * The same duration from milliseconds, which is what a caller that already holds a
 * running clock has.
 *
 * This is the one that both surfaces must use. A caller holding milliseconds has no
 * business converting them to timestamps to borrow the ISO wrapper, and doing that
 * conversion is how a second implementation grows next to the first.
 */
export function formatDurationMs(ms: number, precision: DurationPrecision = 'compact'): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''

  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return precision === 'precise' && seconds % 60 !== 0
      ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
      : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`

  // Days only make sense where there is room for them: a sidebar too narrow to say
  // "1d 3h" without truncating the title should say "31h" and let the reader wonder.
  return precision === 'precise' ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`
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
  const parent = session.parentSessionId
    ? `parent session: ${session.parentSessionId}${
        session.parentAgent ? ` (${session.parentAgent})` : ''
      }`
    : ''
  return [
    session.id,
    parent,
    sessionCommandLine(session),
    `${session.lineCount} lines · ${formatBytes(session.charCount)} · ${session.cols}x${session.rows}`,
    `workdir: ${session.workdir}`,
  ]
    .filter((line) => line.trim() !== '')
    .join('\n')
}

/** Everything worth showing about a session on one line (`pty_list`-style). */
export function sessionDetailLine(session: PTYSessionInfo): string {
  return [
    `PID ${session.pid}`,
    sessionTiming(session),
    sessionCommandLine(session),
    // Both counts, because they disagree in exactly the case that matters: a TUI
    // that repaints its screen as escape sequences is one line and tens of
    // thousands of characters. A line count alone makes that look like an idle
    // session.
    `${session.lineCount} lines`,
    `${formatBytes(session.charCount)}`,
    `${session.cols}x${session.rows}`,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/** Human-readable size, using the same units the download dialog reports. */
export function formatBytes(chars: number): string {
  if (!Number.isFinite(chars) || chars < 0) return '0 B'
  if (chars < 1024) return `${chars} chars`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} kB`
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Newest activity first.
 *
 * A finished session is ordered by when it ended (a long-running one that just
 * exited should not sink below one that started later but ended earlier), a
 * running one by its start time. Stable for equal timestamps. Shared by the
 * server (list responses) and the client (WebSocket updates), so both agree.
 *
 * `exitAt` first, and the reason is measured rather than cosmetic: `endedAt` is LOST
 * across a restart - see the field's comment in the session type - while `exitAt`
 * records when the process actually stopped. A restarted session therefore has no
 * `endedAt` and used to sort as if it were still running, which put it above sessions
 * that had finished later. Preferring `exitAt` only changes the order for those
 * sessions, and it changes it to the correct one.
 */
/**
 * The fields this ordering reads, and nothing else.
 *
 * Generic over them rather than over `PTYSessionInfo`, because the rule belongs to a
 * LIST and a list can be narrower than the full session record - the sidebar panel
 * carries a trimmed shape and must order by exactly the same rule as the web UI, which
 * is the whole point of sharing it. Same reason `filterGroups` is generic.
 */
export interface TimeOrdered {
  readonly id: string
  /**
   * Optional on purpose, and only here.
   *
   * The server always sends it - `PTYSessionInfo` requires it - but the sidebar panel
   * reads the payload across a process boundary and must not fall over on a malformed
   * one. A missing timestamp degrades to `0`, which sorts it last instead of throwing, and
   * that is worth more than a stricter type at a boundary nobody controls. Every web-side
   * caller passes a real one, so nothing there changes.
   */
  readonly createdAt?: string
  readonly endedAt?: string
  readonly exitAt?: string
}

export function sortSessionsByTime<T extends TimeOrdered>(sessions: readonly T[]): T[] {
  const activity = (session: T): number =>
    // `?? ''` at the end: NaN becomes 0 through the `||`, which is what puts a session
    // without a usable timestamp last instead of throwing.
    Date.parse(session.exitAt ?? session.endedAt ?? session.createdAt ?? '') || 0

  return [...sessions].sort(
    (a, b) =>
      activity(b) - activity(a) ||
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
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

/**
 * Group already time-sorted sessions by the OpenCode session that spawned them.
 * The first child carries the group's newest activity, so Map insertion order is
 * also the desired newest-group-first order.
 */
export function groupSessionsByParent<T extends ParentGrouped>(
  sessions: readonly T[]
): PTYSessionGroup<T>[] {
  const groups = new Map<string, PTYSessionGroup<T>>()

  for (const session of sortSessionsByTime(sessions)) {
    const parentSessionId = session.parentSessionId?.trim() || undefined
    const key = parentSessionId ?? ''
    const group = groups.get(key)
    if (group) {
      group.sessions.push(session)
      group.parentAgent ??= session.parentAgent
      continue
    }

    groups.set(key, {
      key,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(session.parentAgent === undefined ? {} : { parentAgent: session.parentAgent }),
      sessions: [session],
    })
  }

  return [...groups.values()]
}

/** Human-readable group heading, falling back when the parent no longer exists. */
export function parentSessionGroupTitle<T>(
  group: PTYSessionGroup<T>,
  titles: Readonly<Record<string, string>>
): string {
  // Unchanged logic, generic signature: the fallback chain here is the tested contract
  // (a web-API parent, then ungrouped, then a known title, then the raw id) and rewriting
  // it while making it generic would have been inventing a second set of answers.
  if (group.parentSessionId === WEB_API_PARENT_SESSION_ID) return 'Web API / manual'
  if (!group.parentSessionId) return 'Ungrouped'

  const title = titles[group.parentSessionId]?.trim()
  return title || `Session ${group.parentSessionId}`
}
