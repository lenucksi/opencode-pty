import { insert } from '@opentui/solid'
import { jsx } from '@opentui/solid/jsx-runtime'

import {
  formatDetail,
  formatDuration,
  isFinished,
  type PanelSession,
  sessionDurationMs,
  tail,
} from './lib.ts'
import type { Tones } from './tones.ts'

/**
 * The output dialog: one session's screen, drawn over everything.
 *
 * Its own module because it is a different surface from the sidebar - a modal the host puts on its
 * own top layer, not a section inside the sidebar tree - and because `render.ts` grew past the
 * point where one file holds both without a reader losing the thread.
 *
 * `lib.ts` still owns what the dialog says: this file owns only where it goes.
 */

export interface DialogView {
  readonly tones: Tones
  readonly session: PanelSession
  /** Its current row from the panel, so a process that exits stops the timer. */
  readonly live: PanelSession
  /** The clock the run timer reads. */
  readonly now: number
  /** Its plain output. */
  readonly output: string
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
    children: jsx('text', { children: (): string => tail(view.output, view.rows) }),
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
