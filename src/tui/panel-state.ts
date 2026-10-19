import { filterGroups, normalizeQuery } from '../web/shared/session-search.ts'
import {
  groupSessionsByParent,
  parentSessionGroupTitle,
  type PTYSessionGroup,
  sortSessionsByTime,
} from '../web/shared/session-meta.ts'
import { isFinished, type PanelSession, truncateText } from './lib.ts'

/**
 * The panel's state, and every transition it can make.
 *
 * All of it pure: a transition takes the state as a draft and mutates it, exactly as
 * the host's store does. That split exists so the decisions - what the header says,
 * when a start is given up on, what a failure does to a list that was correct a moment
 * ago - can be tested without a terminal, a server or a host, which is the only way
 * they could be tested at all.
 */

/** The output dialog's own state. */
export interface DialogState {
  /** Which session the dialog is showing. */
  id: string
  /** Its plain buffer, or a message saying why it could not be read. */
  output: string
  /** The clock the run timer reads, advanced once a second while it is open. */
  now: number
}

export interface PanelState {
  sessions: PanelSession[]
  status: string
  /** The resolved server, or null while none is known to be running. */
  origin: string | null
  /** Consecutive failed attempts to start one, which stop the panel retrying. */
  startFailures: number
  /** Why the last attempt failed, reported rather than swallowed. */
  lastStartError: string | null
  /** The open output dialog, or null when none is showing. */
  dialog: DialogState | null
}

/**
 * Why a start is not free, stated where the status line that names it is written:
 * the command it runs creates and deletes a session, which does not belong on a
 * load path - so it happens only when someone expands the panel.
 */
export const IDLE_STATUS = 'not running — click to start'

/** Before the first answer arrives, so the panel says something rather than nothing. */
export const STARTING_STATUS = 'starting…'

/** Consecutive failures after which the panel stops trying on its own. */
export const MAX_START_FAILURES = 3

/**
 * The status once the retries are spent and nothing said why.
 *
 * Names the gesture that does work - toggle the panel - because the one that worked
 * before no longer does.
 */
export const RETRY_STATUS = 'unavailable — toggle to retry'

/**
 * How many finished rows the expansion shows before it admits there are more.
 *
 * The sidebar is ~40 columns and the archive is hundreds of entries, so the expansion
 * cannot show all of it - and it must not pretend to. The footer states how many are
 * shown when the two numbers differ.
 *
 * It caps ALL finished rows, not only the failed ones: a clean exit is still the run
 * the reader just made, and hiding it made a session they had started a second ago
 * look like it was never created.
 */
export const FINISHED_LIMIT = 10

export function initialPanelState(): PanelState {
  return {
    sessions: [],
    status: STARTING_STATUS,
    origin: null,
    startFailures: 0,
    lastStartError: null,
    dialog: null,
  }
}

/**
 * The status while there is no server.
 *
 * After the retries are used up this reports the CAUSE rather than a bare
 * "unavailable": the common one is real and actionable - the PTY plugin not being
 * registered in the project's opencode.jsonc - and no number of retries will fix
 * that. Before them it says it is trying, which is what it is doing.
 */
export function statusWhenUnavailable(failures: number, cause: string | null): string {
  if (cause === null) {
    // Nobody has asked yet, so the click is the way forward and the text should say
    // so. Once the retries are used up the click no longer starts anything, and
    // "click to start" would invite a gesture that does nothing - so the text has to
    // name the gesture that does: collapsing and expanding again.
    return failures >= MAX_START_FAILURES ? RETRY_STATUS : IDLE_STATUS
  }
  if (failures < MAX_START_FAILURES) return 'starting server…'
  const first = cause.split('\n')[0] ?? cause
  return `unavailable: ${first.slice(0, 44)}`
}

/**
 * The order the panel lists sessions in: running first, then finished.
 *
 * The partition is this file's; the order inside each half is the SHARED one
 * (`sortSessionsByTime`), which is what makes the sidebar and the web UI agree about
 * which run is newer. An earlier version had its own comparator here, ordered by
 * `createdAt`, and disagreed with the web list for every session that had actually
 * finished - the server exposes `exitAt` precisely because `endedAt` is lost across a
 * restart, and this file was sorting on the weaker field.
 *
 * The list is every session the server knows, so on a machine with any history it is
 * hundreds of finished records. Listed in the server's order, the one process that is
 * actually running sits below all of them - a live session you have to scroll to find
 * is not a live session you can watch. The header's count stays the true total, so
 * nothing is hidden by the ordering.
 */
export function orderForDisplay(sessions: readonly PanelSession[]): PanelSession[] {
  // Two steps, and only the first is ours. The PARTITION - running above finished - is
  // the sidebar's own requirement: a live process below a page of records is one you have
  // to scroll to find. The ORDER WITHIN each half is the shared rule, so a 90-second run
  // and a restarted one land where the web UI puts them rather than where this file once
  // decided by itself.
  const running = sortSessionsByTime(sessions.filter(isRunning))
  const finished = sortSessionsByTime(sessions.filter((session) => !isRunning(session)))
  return [...running, ...finished]
}

/** Whether a session is one a reader would want to watch. */
export function isRunning(session: PanelSession): boolean {
  return session.status === 'running'
}

/**
 * Whether a finished session ended badly.
 *
 * A non-zero exit or a signal. An `exit 0` is a record, not an event: it can only ever
 * be found again through the web UI, and on a machine with history there are hundreds
 * of them. What the expansion shows is the rows that carry news.
 */
export function endedBadly(session: PanelSession): boolean {
  if (typeof session.exitCode === 'number') return session.exitCode !== 0
  return typeof session.exitSignal === 'string' && session.exitSignal.length > 0
}

/**
 * How many finished sessions ended badly, uncapped.
 *
 * Uncapped on purpose: the footer reports this while the list shows at most
 * `FINISHED_FAILURE_LIMIT` of them, so a capped count would describe the visible
 * rows rather than the archive.
 */
export function failureCount(sessions: readonly PanelSession[]): number {
  return sessions.filter((session) => isFinished(session) && endedBadly(session)).length
}

/**
 * The failed finished rows, newest first, capped.
 *
 * Order comes from the input, which `orderForDisplay` already put newest-first within
 * the finished group - filtering preserves it, so there is no second sort to disagree
 * with the first.
 */
export function failedFinished(sessions: readonly PanelSession[]): PanelSession[] {
  return sessions
    .filter((session) => isFinished(session) && endedBadly(session))
    .slice(0, FINISHED_LIMIT)
}

/**
 * The finished rows the expansion lists: newest first, capped, success or failure.
 *
 * The order comes from the input, which `orderForDisplay` already put newest-first, so
 * there is no second sort to disagree with the first.
 */
export function finishedRows(sessions: readonly PanelSession[]): PanelSession[] {
  return sessions.filter(isFinished).slice(0, FINISHED_LIMIT)
}

/**
 * What the panel's body lists.
 *
 * Running sessions always, because that is what a glance is for. The failed finished
 * ones only when the footer asked for them - so the expansion is additive and can
 * never hide the one process that is alive.
 *
 * A `killing` session is neither: it is the transient state before the exit callback
 * reports `killed`, and listing it would show a state the user cannot act on.
 */
export function visibleSessions(
  sessions: readonly PanelSession[],
  showFinished: boolean
): PanelSession[] {
  const running = sessions.filter(isRunning)
  if (!showFinished) return running
  return [...running, ...finishedRows(sessions)]
}

/** One group of sessions: everything one OpenCode session started. */
export interface PanelGroup {
  readonly key: string
  readonly parentSessionId?: string
  readonly parentAgent?: string
  readonly sessions: PanelSession[]
  /** Whether any session in the group is running, which is what the order keys on. */
  readonly hasRunning: boolean
}

/**
 * The panel's rows, grouped by the OpenCode session that started them.
 *
 * The GROUPING is the shared rule (`groupSessionsByParent`, which also supplies the
 * ungrouped bucket), and the ORDER is one step of our own: groups holding a running
 * session first. A parent conversation with something alive in it is the thing a glance
 * is for, and the shared order alone puts groups purely by age.
 *
 * The grouping applies to whatever `visibleSessions` selected - so the failed finished
 * runs land in their parent conversation too, rather than in one flat pile at the bottom.
 *
 * The QUERY is applied here as well, through the shared `filterGroups`, so the sidebar and
 * the browser cannot disagree about what matches: a group survives when its own title
 * matches (someone searching for a conversation wants that whole group) or when at least one
 * child does, and each group carries only the children that survived. A group that kept
 * nothing is gone, not drawn empty.
 */
export function groupsForDisplay(
  sessions: readonly PanelSession[],
  titles: Readonly<Record<string, string>> = {},
  query = ''
): PanelGroup[] {
  const grouped: PTYSessionGroup<PanelSession>[] = groupSessionsByParent(sessions)
  const survivors = filterGroups(
    grouped,
    // The same heading the group is drawn with, so a title match means what the reader sees.
    (group) => parentSessionGroupTitle(group, titles),
    query
  )
  const groups: PanelGroup[] = survivors.map((entry) => ({
    key: entry.group.key,
    ...(entry.group.parentSessionId === undefined
      ? {}
      : { parentSessionId: entry.group.parentSessionId }),
    ...(entry.group.parentAgent === undefined ? {} : { parentAgent: entry.group.parentAgent }),
    sessions: entry.sessions,
    // From the SURVIVORS: a group whose only running session the filter removed is not a group
    // holding a running session, and must not claim the top of the list.
    hasRunning: entry.sessions.some(isRunning),
  }))
  // Two stable halves, relative order untouched inside each - so a group that has been
  // above another one stays above it.
  return [
    ...groups.filter((group) => group.hasRunning),
    ...groups.filter((group) => !group.hasRunning),
  ]
}

/**
 * How many rows a group may hold and still be always shown.
 *
 * Taken from the host's own MCP sidebar (`feature-plugins/sidebar/mcp.tsx`, which folds only
 * past `list().length > 2`): a group of one or two is never hidden behind a header, so the
 * collapse control never offers to put the one process a reader came for out of sight.
 */
export const GROUP_AUTO_OPEN_LIMIT = 2

/**
 * Whether a group's rows are drawn.
 *
 * A small group is always open, so the fold can never hide the whole point of the glance. A
 * bigger one follows the reader, keyed by the parent session id - and a key for a
 * conversation that is gone simply never matches, which is the honest outcome rather than a
 * group that reopens itself.
 */
export function isGroupOpen(
  sessionCount: number,
  key: string,
  collapsedGroups: readonly string[]
): boolean {
  if (sessionCount <= GROUP_AUTO_OPEN_LIMIT) return true
  return !collapsedGroups.includes(key)
}

/** How many sessions, in words. One is not "1 sessions". */
export function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`
}

/**
 * The header's count while a filter is active: what is shown, then the true total.
 *
 * Both numbers, because either alone is a half-truth: the total would hide that the filter
 * narrowed anything, and the shown count alone would look like a smaller archive. `shown` is
 * counted over the same set the body draws, so `0 of 200` and "nothing matches" agree instead
 * of contradicting each other - a numerator over the whole archive would name rows the reader
 * can see nowhere.
 */
export function sessionCountForHeader(total: number, shown: number, query: string): string {
  if (normalizeQuery(query) === null) return sessionCountLabel(total)
  return `${shown} of ${total}`
}

/**
 * What the body says when it has no rows.
 *
 * Under an active filter a bare "nothing running" is a different claim from the truth - it
 * says no process is alive when what happened is that the query excluded them all - so the
 * query is named. Echoes what was typed (trimmed), not the normalised needle, so the reader
 * recognises their own words.
 */
export function emptyListLabel(query: string): string {
  if (normalizeQuery(query) === null) return '   nothing running'
  return `   nothing matches “${query.trim()}”`
}

/** How much of the query the header chip shows before it clips. */
export const FILTER_CHIP_MAX = 14

/**
 * The header's filter chip, or '' when nothing is filtered.
 *
 * Empty rather than a placeholder when no filter is set: a zero-width element presents no hit
 * target, so the header never offers a click that would clear nothing - the same rule the
 * clear-finished control follows.
 */
export function filterChipLabel(query: string): string {
  if (normalizeQuery(query) === null) return ''
  return `${truncateText(query.trim(), FILTER_CHIP_MAX)} ✕`
}

/** Nothing is listening and nobody asked for a server. */
export function noteNoServer(state: PanelState, asked: boolean): void {
  if (asked) state.startFailures++
  state.status = asked
    ? statusWhenUnavailable(state.startFailures, state.lastStartError)
    : IDLE_STATUS
  state.sessions = []
  state.origin = null
}

/** The list arrived. Also the reset point: a working server clears the backoff. */
export function noteListSuccess(
  state: PanelState,
  origin: string,
  sessions: readonly PanelSession[]
): void {
  state.origin = origin
  state.sessions = orderForDisplay(sessions)
  state.startFailures = 0
  state.lastStartError = null
  state.status = sessionCountLabel(sessions.length)
}

/**
 * The server answered, or did not.
 *
 * The origin is cleared so the next tick re-discovers it: the server binds a
 * fresh random port on every start, so yesterday's address is a dead port. The
 * list goes with it, because showing sessions next to an error invites the reading
 * that the list is current.
 */
export function noteUnreachable(state: PanelState, error: unknown): void {
  state.origin = null
  state.sessions = []
  state.status = 'server unreachable'
  state.lastStartError = String(error)
}

/** Why a start attempt failed, remembered so the header can name the cause. */
export function noteStartError(state: PanelState, error: unknown): void {
  state.lastStartError = String(error)
}

/** The dialog opened on this session, showing a placeholder until the read lands. */
export function noteDialogOpened(state: PanelState, id: string, now: number): void {
  state.dialog = { id, output: 'loading…', now }
}

/**
 * The dialog closed.
 *
 * Cleared rather than left behind: a stale buffer would be what a second dialog
 * shows for a poll interval, which reads as the plugin reading the wrong session.
 */
export function noteDialogClosed(state: PanelState): void {
  state.dialog = null
}

/** The run timer moved on. Ignored when no dialog is open. */
export function noteDialogTick(state: PanelState, now: number): void {
  if (state.dialog !== null) state.dialog.now = now
}

/** A buffer read landed, or failed and says so. */
export function noteDialogOutput(state: PanelState, buffer: string): void {
  if (state.dialog !== null) state.dialog.output = buffer
}
