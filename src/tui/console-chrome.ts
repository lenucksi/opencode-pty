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
 * The sideways scrollbar, shown only when the screen does not fit.
 *
 * opentui's scrollbox cannot scroll sideways: its scroll size is the content's
 * COMPUTED width, which is the viewport's width, so it never has more to show than
 * it already does. The offset is therefore ours, and so is this bar - two arrows and
 * the position, which is all a 40-column sidebar can carry.
 */
export function horizontalBar(view: SessionPanelView): unknown {
  const visible = view.state.consoleWidth
  if (visible <= 0) return null
  const widest = widestRow(view.state.screen)
  if (widest <= visible) return null
  const offset = Math.min(view.state.scrollLeft, widest - visible)
  const page = Math.max(1, visible - 8)
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    flexShrink: 0,
    children: [
      jsx('text', {
        fg: view.tones.muted,
        children: '\u25c0',
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onScrollBy(-page)
        },
      }),
      jsx('text', {
        flexGrow: 1,
        fg: view.tones.muted,
        children: ` ${offset}-${Math.min(widest, offset + visible)} of ${widest} cells `,
      }),
      jsx('text', {
        fg: view.tones.muted,
        children: '\u25b6',
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onScrollBy(page)
        },
      }),
    ],
  })
}
