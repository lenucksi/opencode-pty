import type { MouseEvent } from '@opentui/core'
import { insert } from '@opentui/solid'
import { jsx } from '@opentui/solid/jsx-runtime'

import {
  formatDuration,
  rowLabel,
  rowTone,
  ROW_BULLET,
  sessionDurationMs,
  type PanelSession,
} from './lib.ts'
import { orderForDisplay } from './panel-state.ts'
import type { Tones } from './render.ts'

/**
 * The PTY panel inside a session: the processes THIS conversation started, with one of
 * them on screen.
 *
 * ## Why the session panel and not the sidebar
 *
 * A PTY session belongs to the OpenCode session that spawned it - the web UI groups its
 * list by `parentSessionId` for the same reason. So the view of those processes belongs
 * next to the conversation that asked for them: while a build fails on screen, the chat
 * that commissioned it is right there.
 *
 * ## Read-only, and that is the SDK's ceiling on 2.0.23
 *
 * The panel cannot type into a session, and the reason is measured rather than assumed:
 * `context.keymap` offers exactly `layer()`, `dispatch()` and `shortcuts()`, so a plugin
 * can bind NAMED COMMANDS and nothing else. There is no access to raw key events -
 * `packages/plugin/src/tui/context.ts` declares neither `intercept` nor `useKeyboard`,
 * while the host's own terminal pane uses `Keymap.use()` from the internal TUI context,
 * which a plugin does not get. So `pty_write` from free typing, scrolling the output and
 * resizing are all unreachable from a TUI plugin on this version. What is left is a
 * better place to READ, which is what this is.
 *
 * This file is pure state plus a view, like `panel-state.ts` and `render.ts`, so the
 * decisions can be tested without a terminal.
 */

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
}

export function initialSessionPanelState(): SessionPanelState {
  return { sessionID: null, sessions: [], selected: null, screen: '', now: Date.now() }
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

/** What the panel shows before a session is picked, or while none is chosen. */
export const NO_SELECTION_SCREEN = 'no PTY session selected'

/** What it shows while the screen is being read. */
export const LOADING_SCREEN = 'loading…'

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
  return orderForDisplay(sessions.filter((session) => session.parentSessionId === sessionID))
}

/**
 * The list arrived.
 *
 * A selection that has disappeared - the session was removed, or this conversation's
 * group is empty - falls back to the first running session, because that is the one a
 * reader opening a panel wants to see. With nothing running, the first row is selected
 * rather than nothing, so the panel is never empty for no reason.
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

/**
 * How many rows of output the panel may show.
 *
 * A budget, not a measurement: `PanelInput` carries a width but no height, and the host
 * does not report the panel's own height. So this spends what the terminal has, minus
 * the header and the list, and the screen box is sized from it - which means the box and
 * its content are always the same height and the output cannot push the layout around.
 * Half the terminal is the share: the list needs the rest.
 */
export function panelScreenRows(rendererHeight: number, listRows: number): number {
  return Math.max(3, Math.floor(rendererHeight / 2) - listRows - 4)
}

export interface SessionPanelView {
  readonly tones: Tones
  readonly state: SessionPanelState
  /** The fresh list, so the selected row's timer stops when the process does. */
  readonly live: readonly PanelSession[]
  /** True while the host has this panel focused. */
  readonly focused: boolean
  /** `fullscreen` when the reader asked for the whole screen. */
  readonly fullscreen: boolean
  readonly screenRows: number
  readonly onSelect: (id: string) => void
}

/** One row, with the selected one marked. */
function rowFor(view: SessionPanelView, session: PanelSession) {
  const tone = rowTone(session)
  const selected = view.state.selected === session.id
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    children: [
      jsx('text', {
        fg:
          tone === 'success'
            ? view.tones.success
            : tone === 'error'
              ? view.tones.error
              : view.tones.muted,
        children: ROW_BULLET,
      }),
      jsx('text', {
        flexGrow: 1,
        // The selection is marked in the TEXT, not only by colour: a reader who cannot
        // distinguish the tones still has to see which row is on screen.
        fg: selected ? view.tones.base : view.tones.muted,
        children: selected ? `> ${rowLabel(session)}` : `  ${rowLabel(session)}`,
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onSelect(session.id)
        },
      }),
    ],
  })
}

/**
 * The whole panel: a header, this session's rows, and the selected session's screen.
 *
 * An accessor for everything that changes with the poll, so the panel updates in place
 * instead of being torn down and rebuilt - which is what keeps the reader's scroll
 * position and the host's focus where they were.
 */
export function sessionPanelView(view: SessionPanelView) {
  const chosen = selectedLive(view.state, view.live)
  const header = jsx('box', {
    flexDirection: 'row',
    width: '100%',
    children: [
      jsx('text', {
        flexGrow: 1,
        fg: view.tones.base,
        children: (): string => {
          const count = view.state.sessions.length
          const focus = view.focused ? '  (focused)' : ''
          const mode = view.fullscreen ? 'fullscreen' : 'panel'
          const label = count === 1 ? '1 session' : `${count} sessions`
          return `PTY  ${label}  ${mode}${focus}`
        },
      }),
      jsx('text', {
        fg: view.tones.muted,
        // The run timer of the selected session, in the header's right corner. Empty
        // rather than "0s" when the start cannot be read: a duration nobody can compute
        // should not be shown as none.
        children: (): string => {
          if (chosen === null) return ''
          const ms = sessionDurationMs(chosen, view.state.now)
          return ms === null ? '' : formatDuration(ms)
        },
      }),
    ],
  })

  const list = jsx('box', {
    flexDirection: 'column',
    width: '100%',
    children: (): unknown[] => {
      if (view.state.sessions.length === 0) {
        return [
          jsx('text', {
            fg: view.tones.muted,
            children: '   this conversation started no PTY session',
          }),
        ]
      }
      return view.state.sessions.map((session) => rowFor(view, session))
    },
  })

  const screen = jsx('box', {
    width: '100%',
    height: view.screenRows,
    overflow: 'hidden',
    // A plain box rather than a scrollbox, for the measured reason in `render.ts`: a
    // scrollbox renders nothing when its text contains a line break.
    children: jsx('text', { children: (): string => view.state.screen }),
  })

  const frame = jsx('box', {
    width: '100%',
    border: true,
    borderStyle: 'single',
    borderColor: view.tones.border,
    backgroundColor: view.tones.raised,
  })
  insert(frame, screen)
  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    children: [header, list, frame],
  })
}
