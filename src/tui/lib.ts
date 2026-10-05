/**
 * Pure logic for the PTY sidebar: no TUI, no I/O, no host API.
 *
 * Kept separate from the wiring so it can be unit-tested. The TUI half cannot be
 * driven headlessly, so every decision worth arguing about lives in here instead:
 * what a row says, what counts as finished, how long a run took, which candidate
 * address is the server.
 */

/**
 * A PTY session as the panel reads it, mirroring the server's `/api/sessions`
 * shape.
 *
 * Typed as the subset the panel uses rather than imported from the server's
 * types: the panel crosses a process boundary, and a field it never reads is a
 * field it cannot break on.
 */
export interface PanelSession {
  readonly id: string
  readonly title?: string
  readonly status?: string
  readonly lineCount?: number
  readonly exitCode?: number
  readonly exitSignal?: string
  readonly pid?: number
  readonly command?: string
  readonly args?: readonly string[]
  readonly workdir?: string
  /**
   * The OpenCode session that started this one, when it was started by a tool call.
   *
   * This is what ties a PTY session to the conversation that commissioned it: the web
   * UI groups its list by it, and the session panel shows exactly the group belonging to
   * the session you are in. Absent for a session started by hand, which is then not
   * shown in any session's panel - correct, because nobody in that conversation asked
   * for it.
   */
  readonly parentSessionId?: string
  /** ISO: when the process started. */
  readonly createdAt?: string
  /**
   * ISO: when the process stopped.
   *
   * Distinct from `endedAt`, which a restart loses - see the field's comment in
   * `src/plugin/pty/types.ts`. A removed session has neither, which is why the
   * row below shows the status word rather than a duration.
   */
  readonly exitAt?: string
}

/** Title column width in the sidebar. */
const TITLE_MAX = 24

/**
 * Every row carries the same bullet, matching the built-in sidebar items (MCP,
 * File Tree, Todo); the colour carries the state instead.
 */
export const ROW_BULLET = '• '

/** The trailing state field of a row. */
function rowTail(session: PanelSession): string {
  if (session.status === 'running') {
    return `${typeof session.lineCount === 'number' ? session.lineCount : 0}L`
  }
  if (typeof session.exitCode === 'number') return `exit ${session.exitCode}`
  if (typeof session.exitSignal === 'string' && session.exitSignal.length > 0) {
    return `signal ${session.exitSignal}`
  }
  // `killing` and `killed` carry no exit code, so rendering those as `exit ?`
  // reads as a bug. The status word is the honest answer.
  return typeof session.status === 'string' && session.status.length > 0 ? session.status : '?'
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/**
 * A row's text WITHOUT its bullet, so the caller can colour the bullet
 * separately - the built-in sidebar items style the glyph and leave the label
 * in the normal text colour.
 */
export function rowLabel(session: PanelSession): string {
  const title = session.title && session.title.length > 0 ? session.title : 'untitled'
  return `${truncate(title, TITLE_MAX)}  ${rowTail(session)}`
}

/**
 * Which theme colour a row's bullet should take, as a semantic key.
 *
 * Returned as a key rather than a colour so this stays pure: the palette lookup
 * belongs to the caller, which is the one holding the theme.
 */
export function rowTone(session: PanelSession): 'success' | 'error' | 'muted' {
  if (session.status === 'running') return 'success'
  if (typeof session.exitCode === 'number' && session.exitCode !== 0) return 'error'
  return 'muted'
}

/**
 * Whether a session has stopped.
 *
 * `killing` is deliberately NOT finished: it is the transient state between the
 * kill request and the exit callback that reports `killed`, so treating it as
 * finished would let a clear race the process teardown.
 */
export function isFinished(session: PanelSession): boolean {
  return session.status === 'exited' || session.status === 'killed'
}

/** The sessions a "clear finished" acts on, kept in their list order. */
export function finishedSessions(list: readonly PanelSession[]): readonly PanelSession[] {
  return list.filter(isFinished)
}

/**
 * The header's clear-action label, or null when there is nothing to clear.
 *
 * Null rather than a disabled label, so the header never offers a control that
 * would delete nothing - and so it can never read as touching live sessions.
 */
export function clearActionLabel(list: readonly PanelSession[]): string | null {
  return finishedSessions(list).length > 0 ? '(clear finished)' : null
}

/** The collapsible header's text: chevron, panel name, status. */
export function headerLabel(input: { collapsed: boolean; status: string }): string {
  const chevron = input.collapsed ? '▶' : '▼'
  return `${chevron} PTY  ${input.status}`
}

/**
 * The footer line: how many sessions are finished, how many of them failed, and
 * whether the expansion is open.
 *
 * Null when there is nothing to expand, so the footer never offers a click that would
 * open nothing - the same rule the header's clear control follows.
 *
 * The count is the ARCHIVE's, not the visible rows': the list shows at most
 * `FINISHED_FAILURE_LIMIT` failed rows, and a line that said "3 failed" while showing
 * 3 of 17 would be describing the screen instead of the state. When the two numbers
 * differ the line states both.
 */
export function archiveLabel(input: {
  finished: number
  failed: number
  shown: number
  expanded: boolean
}): string | null {
  // Null unless something failed. A finished session with an exit 0 is a record, not an
  // event, and the expansion shows only failures - so a line reading "1 finished, none
  // failed" would be a click that opens nothing. The header already carries the true
  // total, so nothing is lost by staying absent.
  if (input.finished === 0 || input.failed === 0) return null
  const arrow = input.expanded ? '▾' : '▸'
  // `N of M failed` when the cap cut the list: the two numbers differ, and a line that
  // named only the visible ones would describe the screen instead of the archive.
  const detail =
    input.shown < input.failed
      ? `${input.shown} of ${input.failed} failed`
      : `${input.failed} failed`
  return `${arrow} ${input.finished} finished · ${detail}`
}

/**
 * Header block for the output dialog - the detail that does not fit a row.
 *
 * Capped at TWO lines on purpose: every line spent here is a line unavailable to
 * the output, and a taller header pushes the dialog past the screen bottom.
 */
export function formatDetail(session: PanelSession): string {
  const args = Array.isArray(session.args)
    ? session.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  const command = [session.command ?? '', ...args].filter(Boolean).join(' ')
  return [
    `${session.id}  ${session.status ?? '?'}  pid ${session.pid ?? '?'}  lines ${session.lineCount ?? 0}`,
    [command, session.workdir ?? ''].filter(Boolean).join('  ·  '),
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * How long a session ran, in milliseconds, or null when that cannot be said.
 *
 * `exitAt` is the end of a stopped process; a running one is measured to `now`,
 * which is why the caller supplies the clock rather than this reading it - a
 * second-granularity dialog should not wake this function on its own.
 *
 * Null when the start is missing or unreadable, and NOT null for an inverted
 * range: a clock that moved backwards between the server and the panel yields a
 * number, and the formatter clamps it to `0s`, which is a truthful "less than a
 * second" instead of a negative duration nobody can render.
 */
export function sessionDurationMs(session: PanelSession, now: number): number | null {
  const started = Date.parse(session.createdAt ?? '')
  if (!Number.isFinite(started)) return null
  const stopped = Date.parse(session.exitAt ?? '')
  return (Number.isFinite(stopped) ? stopped : now) - started
}

/**
 * A duration as a compact label.
 *
 * Seconds zero-padded below an hour (`1m 05s`), minutes above it (`2h 07m`): the
 * unit that matters is the leading one. Non-finite, negative and missing inputs
 * all become `0s`, because a `NaN` or an empty cell in a corner of the terminal
 * is worse than a floor.
 */
export function formatDuration(ms: number | null | undefined): string {
  const totalSeconds =
    typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/**
 * Decode a `/api/sessions/:id/buffer/plain` response into displayable text.
 *
 * The endpoint returns a JSON envelope - `{ plain, byteLength }` - not a raw
 * body, and the content is CRLF-terminated because it is a terminal buffer.
 * Accepts a bare string too, so a caller that gets the body directly is not
 * punished for it.
 */

/**
 * Decode a `/api/sessions/:id/screen` response into displayable text.
 *
 * The endpoint returns the RENDERED screen - one string per row, trailing blanks
 * already removed - not the bytes the program wrote. That distinction is the whole
 * point: `buffer/plain` is `Bun.stripANSI(raw)`, so a cursor move is deleted along
 * with the colour codes and a full-screen program's output arrives unpainted with its
 * layout gone. The screen carries the layout.
 *
 * The rows are joined with newlines and nothing else. A line too wide for the screen
 * therefore occupies two rows here too, which is what the program itself shows; the
 * response's `continuedRows` is there for a reader who needs to know they are one line.
 *
 * Returns '' for anything unreadable rather than throwing: a dialog that cannot show
 * output should show an empty box, not take the panel's refresh down with it.
 */
export function decodeScreen(raw: unknown): string {
  const rows = (value: unknown): string[] | null => {
    if (Array.isArray(value)) {
      return value.filter((line): line is string => typeof line === 'string')
    }
    if (value && typeof value === 'object') {
      const lines = (value as { lines?: unknown }).lines
      if (Array.isArray(lines))
        return lines.filter((line): line is string => typeof line === 'string')
    }
    return null
  }
  // A bare array is accepted so a caller that gets the body directly is not punished
  // for it, exactly as `decodeBuffer` accepted a bare string.
  return (rows(raw) ?? []).join('\n')
}

/**
 * Exactly `lines` lines of `text`, ending with the newest, and marked `…` on the
 * first line when anything was cut.
 *
 * Exactly `lines`, not `lines` plus a marker: the caller hands the result to a box
 * that shows only as many rows as it has, so a marker on top would push the newest
 * line out of sight. That is the whole reason this is not the obvious
 * implementation, and an off-by-one here silently hides the newest output.
 *
 * Lives here rather than in the plugin so it can be tested.
 */
export function tail(text: string, lines: number): string {
  if (lines < 1) return ''
  const all = text.split('\n')
  if (all.length <= lines) return all.join('\n')
  if (lines === 1) return '…'
  return ['…', ...all.slice(-(lines - 1))].join('\n')
}

/**
 * Does this look like the PTY server's `/health` payload?
 *
 * Every published origin is only a hint about where to look, so a candidate is
 * confirmed by this shape. Something else can answer on a loopback port too:
 * CUPS owns `[::1]:631` on the machine this was built on and returns an HTML
 * error page there.
 */
export function isPtyHealth(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const health = value as { status?: unknown; sessions?: unknown }
  return health.status === 'healthy' && !!health.sessions && typeof health.sessions === 'object'
}
