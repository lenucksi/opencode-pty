import type { MouseEvent } from '@opentui/core'
import { insert } from '@opentui/solid'
import { jsx } from '@opentui/solid/jsx-runtime'

import {
  clearActionLabel,
  finishedSessions,
  formatDetail,
  formatDuration,
  headerLabel,
  isFinished,
  rowLabel,
  rowTone,
  ROW_BULLET,
  sessionDurationMs,
  tail,
  type PanelSession,
} from './lib.ts'

/**
 * What the panel draws, as plain inputs and plain callbacks.
 *
 * No context, no storage, no host: the builders take what they read and what they
 * call. That is what makes them testable - the headless renderer needs an element
 * tree, and a tree built from a literal is one; a tree built from a plugin's
 * internals is not.
 *
 * Reactive parts are accessors over these inputs, which is exactly what the JSX
 * compiler emits for `{expression}` and what every opencode sidebar plugin does.
 */

/** The per-row remove control. Leading space so it does not crowd the label. */
export const REMOVE_GLYPH = ' ✕'

/** The colour slots this panel uses, named rather than typed. */
interface Tones {
  readonly base: unknown
  readonly muted: unknown
  readonly success: unknown
  readonly error: unknown
  readonly border: unknown
  readonly raised: unknown
}

export interface PanelView {
  readonly tones: Tones
  readonly collapsed: boolean
  readonly status: string
  readonly sessions: readonly PanelSession[]
  /** Expand/collapse the header. */
  readonly onToggle: (event: MouseEvent) => void
  /** Clear every finished session. */
  readonly onClear: (event: MouseEvent) => void
  /** Open a session's output. */
  readonly onOpen: (session: PanelSession) => void
  /** Remove a session. */
  readonly onRemove: (session: PanelSession) => void
}

/** One session's row: bullet, label, and the remove control. */
function rowFor(view: PanelView, session: PanelSession) {
  const tone = rowTone(session)
  // Bullet and label are SEPARATE elements because the colour belongs on the text
  // itself; nesting a span inside a text and colouring the span rendered
  // uncoloured when this was tried.
  const bullet = jsx('text', {
    fg:
      tone === 'success'
        ? view.tones.success
        : tone === 'error'
          ? view.tones.error
          : view.tones.muted,
    children: ROW_BULLET,
  })
  const label = jsx('text', {
    fg: view.tones.base,
    // Grows so the remove glyph is pushed to the panel's right edge.
    flexGrow: 1,
    children: rowLabel(session),
  })
  const remove = jsx('text', {
    fg: view.tones.muted,
    children: REMOVE_GLYPH,
    // BOTH events, not just the one it acts on: the row opens on mouse UP, so
    // letting the UP through would remove the session and then open its output.
    // opentui bubbles to the parent only while propagation is unbroken.
    onMouseDown: (event: MouseEvent) => event.stopPropagation(),
    onMouseUp: (event: MouseEvent) => {
      event.stopPropagation()
      view.onRemove(session)
    },
  })
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    children: [bullet, label, remove],
  })
}

/** The collapsible header, carrying the count and the clear action. */
function headerFor(view: PanelView) {
  const toggle = (event: MouseEvent): void => {
    event.stopPropagation()
    view.onToggle(event)
  }
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    children: [
      jsx('text', {
        flexGrow: 1,
        fg: view.tones.base,
        onMouseDown: toggle,
        onMouseUp: toggle,
        // An accessor, so the status text follows the poll without the panel being
        // torn down and rebuilt.
        children: (): string => headerLabel({ collapsed: view.collapsed, status: view.status }),
      }),
      jsx('text', {
        fg: view.tones.muted,
        onMouseDown: (event: MouseEvent) => {
          // Without this the click would also collapse the panel, hiding the very
          // list it is cleaning.
          event.stopPropagation()
          view.onClear(event)
        },
        // Empty when nothing is finished: a zero-width element presents no hit
        // target, so the header never offers an action that would delete nothing.
        children: (): string => clearActionLabel(view.sessions) ?? '',
      }),
    ],
  })
}

/** The rows, or nothing at all while collapsed. */
function listFor(view: PanelView) {
  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    children: (): unknown[] => {
      if (view.collapsed) return []
      if (view.sessions.length === 0) {
        return [jsx('text', { fg: view.tones.muted, children: '   (none)' })]
      }
      return view.sessions.map((session) => rowFor(view, session))
    },
  })
}

/** The whole sidebar contribution: header over rows. */
export function sidebarView(view: PanelView) {
  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    children: [headerFor(view), listFor(view)],
  })
}

export interface DialogView {
  readonly tones: Tones
  readonly session: PanelSession
  /** Its current row from the panel, so a process that exits stops the timer. */
  readonly live: PanelSession
  /** The clock the run timer reads. */
  readonly now: number
  /** Its plain output. */
  readonly buffer: string
  /** Height of the scrollable output area, in rows. */
  readonly rows: number
}

/** How much of the screen a dialog may fill, given the host pins its top edge. */
export function dialogRows(screenRows: number): number {
  // The host centres horizontally and puts the top edge a quarter of the screen
  // down, growing downward from there - so HEIGHT is the only shape lever, and it
  // is spent filling to the screen edge. The 12 covers the header, its border and
  // the host's own chrome, so the box cannot run past the bottom.
  return Math.max(6, screenRows - Math.floor(screenRows / 4) - 12)
}

/** The size the host should give the dialog, from the terminal width. */
export function dialogSize(cols: number): 'medium' | 'large' | 'xlarge' {
  // The same thresholds opencode's own plugin manager uses; asking for the widest
  // unconditionally would overflow a narrow terminal.
  return cols >= 128 ? 'xlarge' : cols >= 96 ? 'large' : 'medium'
}

/** The output dialog: a detail header over a scrollable buffer. */
export function outputDialogView(view: DialogView) {
  const header = jsx('box', {
    flexDirection: 'column',
    width: '100%',
    border: true,
    borderStyle: 'single',
    borderColor: view.tones.border,
    backgroundColor: view.tones.raised,
  })
  insert(header, jsx('text', { children: `⟡ ${view.session.title || view.session.id}` }))
  insert(header, jsx('text', { fg: view.tones.muted, children: formatDetail(view.session) }))
  const foot = jsx('box', { flexDirection: 'row', width: '100%' })
  insert(foot, jsx('text', { flexGrow: 1, fg: view.tones.muted, children: 'esc to close' }))
  // The run timer sits in the band's bottom-right corner: as the last row it reads
  // as the footer. Empty rather than "0s" when the session has no usable start,
  // because a duration nobody can compute should not be shown as none.
  insert(
    foot,
    jsx('text', {
      fg: view.tones.muted,
      children: (): string => {
        if (isFinished(view.live) === false && view.live.status === undefined) return ''
        const ms = sessionDurationMs(view.live, view.now)
        return ms === null ? '' : formatDuration(ms)
      },
    })
  )
  insert(header, foot)

  // A plain box, not a scrollbox. Measured against opentui 0.5.14: a scrollbox
  // renders NOTHING when its text contains a line break - and `stickyScroll`
  // together with `stickyStart: 'bottom'` blanks it even for a single line. A box
  // renders multi-line text and clips itself with `overflow: 'hidden'`.
  //
  // So the line budget is the box's height rather than a fixed tail: `tail` returns
  // exactly that many lines, newest last, which is precisely what fits.
  // No `flexShrink: 0` here: measured, removing it changes nothing once the
  // scrollbox is gone. An earlier version needed it for the scrollbox, and a
  // comment claiming it was still required would be a guess dressed as a finding.
  const output = jsx('box', {
    width: '100%',
    height: view.rows,
    overflow: 'hidden',
    children: jsx('text', { children: (): string => tail(view.buffer, view.rows) }),
  })
  const frame = jsx('box', {
    width: '100%',
    border: true,
    borderStyle: 'single',
    borderColor: view.tones.border,
  })
  insert(frame, output)

  return jsx('box', { flexDirection: 'column', children: [header, frame] })
}

/** How many finished sessions a "clear finished" would act on, for reporting. */
export function clearTargetCount(sessions: readonly PanelSession[]): number {
  return finishedSessions(sessions).length
}
