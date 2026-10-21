/**
 * The chrome around the console: the sideways scrollbar and the key hints.
 *
 * Both are about the console and neither is the console, so they live beside it
 * rather than inside the panel's own file - which is also what keeps that file
 * within the size the repository asks for.
 */

import type { MouseEvent } from '@opentui/core'
import { jsx } from '@opentui/solid/jsx-runtime'

import { widestRow } from './screen-content.ts'
import type { SessionPanelView } from './session-panel.ts'

/**
 * The keys that work while the panel is on screen.
 *
 * Text, not a control: a hint that looked like a button would be a promise the panel
 * cannot keep. Shown only while the panel has focus, because the host owns the input
 * scope - an unfocused panel answers none of these keys, and the header already says
 * whether it is focused.
 */
export function keyHints(view: SessionPanelView): string {
  if (!view.focused) return ''
  return 'f3 fullscreen \u00b7 f4 send \u00b7 ctrl+y close'
}

/**
 * Where the thumb of the sideways scrollbar sits.
 *
 * The thumb is what makes the row a scrollbar and not a line of text with two arrows
 * in it: its width is the share of the screen that is on view, its position is where
 * that share starts.
 */
export interface ScrollbarThumb {
  /** The cells between the left arrow and the thumb. */
  readonly start: number
  /** The thumb's own width, in cells. */
  readonly size: number
}

/**
 * The thumb's geometry, in cells.
 *
 * Pure, because this is the arithmetic that can fail quietly: a thumb one cell off is
 * a picture that still looks like a picture, so it is worth being able to say exactly
 * where it belongs.
 *
 * The width is the visible share of the screen, rounded to a whole cell and never
 * smaller than two - a thumb of one cell is a dot, and a dot does not read as a
 * scrollbar. The position is the offset over the scrollable distance, which is why
 * the offset is clamped first: past the end there is nothing left to show, and a thumb
 * that keeps walking would say there were.
 */
export function scrollbarThumb(
  track: number,
  offset: number,
  visible: number,
  total: number
): ScrollbarThumb {
  const width = Math.max(1, Math.floor(track))
  const size = Math.min(width, Math.max(2, Math.round((visible / Math.max(1, total)) * width)))
  const span = Math.max(1, total - visible)
  const at = Math.min(Math.max(0, offset), span)
  const start = Math.round((at / span) * (width - size))
  return { start, size }
}

/**
 * The sideways scrollbar, shown only when the screen does not fit.
 *
 * opentui's scrollbox cannot scroll sideways: its scroll size is the content's
 * COMPUTED width, which is the viewport's width, so it never has more to show than
 * it already does. The offset is therefore ours, and so is this bar.
 *
 * It is drawn as a control and not as text: a track across the whole row, a thumb on
 * it at the position the reader is at, the counter on the track, and the two arrows at
 * the ends - all on the track's own background, so the row reads as one thing. The
 * track is a box with a background rather than a run of spaces, so it covers the row
 * whatever the measured width turns out to be; only the thumb's position is computed.
 */
export function horizontalBar(view: SessionPanelView): unknown {
  const visible = view.state.consoleWidth
  if (visible <= 0) return null
  const widest = widestRow(view.state.screen)
  if (widest <= visible) return null
  const offset = Math.min(view.state.scrollLeft, widest - visible)
  const page = Math.max(1, visible - 8)
  // The counter is short on purpose: `0-82/200` is eight cells, `0-82 of 200 cells`
  // is eighteen, and eighteen of forty is a bar with no bar left in it.
  const counter = `${offset}-${Math.min(widest, offset + visible)}/${widest}`
  // The track is what the two arrows, the counter and the gap on either side of the
  // counter leave over. One cell stays spare, because the measured width can be a
  // cell ahead of the row it is measured in - and a counter that does not fit costs
  // the reader the counter, not the arrow.
  const room = Math.max(1, visible - 4)
  const withCounter = room - counter.length - 1 >= 6
  const track = withCounter ? room - counter.length - 1 : room
  const thumb = scrollbarThumb(track, offset, visible, widest)
  const children: unknown[] = [
    jsx('text', {
      fg: view.tones.muted,
      children: '\u25c0',
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation()
        view.onScrollBy(-page)
      },
    }),
  ]
  if (thumb.start > 0) {
    children.push(jsx('box', { width: thumb.start, flexShrink: 0 }))
  }
  children.push(
    jsx('box', {
      width: thumb.size,
      flexShrink: 0,
      backgroundColor: view.tones.raisedHigh,
    })
  )
  // The rest of the track, then a gap, then the counter, then a gap again: the
  // counter ends up against the right arrow with one cell of air on either side.
  children.push(jsx('box', { flexGrow: 1, flexShrink: 1 }))
  if (withCounter) {
    children.push(jsx('box', { width: 1, flexShrink: 0 }))
    children.push(
      jsx('text', {
        fg: view.tones.muted,
        flexShrink: 0,
        children: counter,
      })
    )
    children.push(jsx('box', { width: 1, flexShrink: 0 }))
  }
  children.push(
    jsx('text', {
      fg: view.tones.muted,
      children: '\u25b6',
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation()
        view.onScrollBy(page)
      },
    })
  )
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    flexShrink: 0,
    backgroundColor: view.tones.raised,
    children,
  })
}
