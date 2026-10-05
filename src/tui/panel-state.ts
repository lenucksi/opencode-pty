import type { PanelSession } from './lib.ts'

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
  buffer: string
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
  if (cause === null) return IDLE_STATUS
  if (failures < MAX_START_FAILURES) return 'starting server…'
  const first = cause.split('\n')[0] ?? cause
  return `unavailable: ${first.slice(0, 44)}`
}

/** How many sessions, in words. One is not "1 sessions". */
export function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`
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
  state.sessions = [...sessions]
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
  state.dialog = { id, buffer: 'loading…', now }
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
export function noteDialogBuffer(state: PanelState, buffer: string): void {
  if (state.dialog !== null) state.dialog.buffer = buffer
}
