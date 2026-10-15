/**
 * The session panel's state: what one OpenCode conversation started, and the transitions
 * it moves through.
 *
 * All pure: a transition takes the state as a draft and mutates it, the way the sidebar's
 * store does, so the decisions can be tested without a terminal, a server or a host.
 *
 * Split from the VIEW for one measurable reason - the combined file grew to 532 lines,
 * which the repository flags as too large for one file - and the boundary is the clean
 * direction available: this module imports NO rendering module, and the view reads state
 * but writes none of it.
 */

import type { PanelSession } from './lib.ts'
import { orderForDisplay } from './panel-state.ts'

export interface SessionPanelState {
  /**
   * Which OpenCode session the panel belongs to, or null before it has rendered.
   *
   * From `PanelInput.sessionID`, and from `ui.panel.current()` for the poll. There is no
   * third source: `data.session` is a lookup that takes an id, so it cannot answer
   * "which session am I in", and the sidebar's slot input is a different claim to hang
   * this on.
   */
  sessionID: string | null
  /** This session's PTY sessions, in display order. */
  sessions: PanelSession[]
  /** Which one is on screen, or null when the list is empty. */
  selected: string | null
  /** Its rendered screen, or a line saying why there is none. */
  screen: string
  /** When the screen was read, so the run timer can be computed from it. */
  now: number
  /**
   * Whether the session list is spread out under the console.
   *
   * COLLAPSED by default, and that stance is the design: the console is the thing a
   * reader opened the panel to watch, and every list row competes with it for the same
   * height. Measured against the reader's screenshot: an 18-record list cost a third of
   * the panel before the console had drawn anything.
   */
  listExpanded: boolean
}

export function initialSessionPanelState(): SessionPanelState {
  return {
    sessionID: null,
    sessions: [],
    selected: null,
    screen: '',
    now: Date.now(),
    listExpanded: false,
  }
}

/** What the panel shows before a session is picked, or while none is chosen. */
export const NO_SELECTION_SCREEN = 'no PTY session selected'

/** What it shows while the screen is being read. */
export const LOADING_SCREEN = 'loading…'

/**
 * How many rows the expanded list may show before it admits there are more.
 *
 * Not a rendering limit, a reading one: a panel is a companion to a conversation, not a
 * table, and a list longer than this pushes the console (the actual reason to have the
 * panel open) out of view. Beyond it the rows are still reachable - through the sidebar
 * and the web UI, which hold them all.
 */
export const SESSION_ROW_LIMIT = 10

/**
 * The rows the expanded list draws, capped, plus how many did not fit.
 *
 * The count of the REST is separate so the panel can say "und N weitere" instead of
 * pretending the list ends at the cut. Zero when the list is folded, because a folded
 * list draws no rows at all and an overflow line under it would contradict that.
 */
export function visibleRows(
  sessions: readonly PanelSession[],
  expanded: boolean
): { rows: readonly PanelSession[]; overflow: number } {
  if (!expanded) return { rows: [], overflow: 0 }
  const rows = sessions.slice(0, SESSION_ROW_LIMIT)
  return { rows, overflow: Math.max(0, sessions.length - rows.length) }
}

/** Fold the list open, or closed. The click on its header row. */
export function noteSessionListToggled(state: SessionPanelState): void {
  state.listExpanded = !state.listExpanded
}

/**
 * The panel was rendered for this OpenCode session.
 *
 * The poll needs the same id and cannot get it from a render, so it reads
 * `ui.panel.current()` - the host's own answer to "is my panel open, and for which
 * session". Writing it here is what lets the list be grouped without a render.
 */
export function noteSessionPanelInput(state: SessionPanelState, sessionID: string): void {
  state.sessionID = sessionID
}

/**
 * The sessions one OpenCode session started.
 *
 * `sessionID` comes from `PanelInput`, not from `data.session`: that one is a lookup
 * taking an id, so it cannot answer "which session am I in". The slot input carries the
 * id, so the grouping has a source.
 *
 * Ordered by `orderForDisplay` for the same reason the sidebar list is: a live process
 * below a page of records is one you cannot watch.
 */
export function sessionsForSession(
  sessions: readonly PanelSession[],
  sessionID: string
): PanelSession[] {
  return orderForDisplay(sessions.filter((s) => s.parentSessionId === sessionID))
}

/**
 * The list arrived.
 *
 * A selection that has disappeared - the session was removed, or this conversation's
 * group is empty - falls back to the first row, because that is the one a reader opening
 * a panel wants to see. With nothing running, the first row is selected rather than
 * nothing, so the panel is never empty for no reason.
 */
export function noteSessionPanelList(
  state: SessionPanelState,
  sessions: readonly PanelSession[],
  sessionID: string
): void {
  const mine = sessionsForSession(sessions, sessionID)
  state.sessions = mine
  const stillThere = mine.some((session) => session.id === state.selected)
  if (stillThere) return
  // `mine[0]`, not a separate search for a running row: `sessionsForSession` ordered the
  // group, so the first row IS the newest running one, and with nothing running it is
  // the newest finished. An explicit `find(isRunning)` here would be a second answer to
  // a question the ordering has already answered - and provably so: with the lookup
  // removed, the same rows come out in the same order.
  state.selected = mine[0]?.id ?? null
  if (state.selected === null) state.screen = NO_SELECTION_SCREEN
}

/** The row the panel is showing, or null when there is no selection. */
export function selectedSession(state: SessionPanelState): PanelSession | null {
  if (state.selected === null) return null
  return state.sessions.find((session) => session.id === state.selected) ?? null
}

/**
 * The row's CURRENT state from the sidebar's list, falling back to the panel's own copy.
 *
 * The panel keeps a snapshot and the sidebar keeps a fresh one, so a process that exits
 * while its screen sits on screen would keep a running timer. Reading the fresh list
 * first is what stops that.
 */
export function selectedLive(
  state: SessionPanelState,
  live: readonly PanelSession[]
): PanelSession | null {
  const chosen = selectedSession(state)
  if (chosen === null) return null
  return live.find((session) => session.id === chosen.id) ?? chosen
}

/** A different row was picked. Its screen is read on the next tick. */
export function noteSessionSelected(state: SessionPanelState, id: string): void {
  if (state.selected === id) return
  state.selected = id
  state.screen = LOADING_SCREEN
}

/** A screen read landed, or failed and says so. */
export function noteSessionScreen(state: SessionPanelState, screen: string, now: number): void {
  if (state.selected === null) return
  state.screen = screen
  state.now = now
}
