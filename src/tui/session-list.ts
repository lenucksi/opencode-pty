/**
 * The session list inside the panel: one row per process, folded by default.
 *
 * Its own file because it is its own subject - which processes are listed, how they
 * are marked, how the fold works - and the panel file is about the console.
 */

import type { MouseEvent } from '@opentui/core'
import { jsx } from '@opentui/solid/jsx-runtime'
import type { Accessor } from 'solid-js'

import { type PanelSession, ROW_BULLET, rowLabel, rowTone } from './lib.ts'
import type { SessionPanelView } from './session-panel.ts'

/** One row, with the selected one marked; the selection reads per click, not per render. */
export function rowFor(view: SessionPanelView, session: PanelSession) {
  const tone = rowTone(session)
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    flexShrink: 0,
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
        // distinguish the tones still has to see which row is on screen. Inside the
        // accessor, so a click re-texts the affected rows instead of re-laying the panel.
        children: (): string => {
          const selected = view.state.selected === session.id
          return selected ? `> ${rowLabel(session)}` : `  ${rowLabel(session)}`
        },
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onSelect(session.id)
        },
      }),
    ],
  })
}

/**
 * The list header, handed over as a row the click folds the list on.
 *
 * COLLAPSED by default, and that is a stance rather than a state saved for later: the
 * list is the index of everything this conversation started, the console is the reason
 * the panel is open, and every list row costs the console something. An 18-record list
 * costs a third of the panel before the console has drawn a thing - measured against the
 * screenshot that reported the collapse.
 *
 * The gesture stays where the list was, so the reader does not have to learn a new
 * position in either state.
 */
export function listHeader(
  view: SessionPanelView,
  sessions: Accessor<PanelSession[]>,
  expanded: Accessor<boolean>
): unknown {
  const count = (): number => sessions().length
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    flexShrink: 0,
    onMouseDown: (event: MouseEvent) => {
      event.stopPropagation()
      view.onToggleList()
    },
    children: [
      jsx('text', {
        fg: view.tones.muted,
        children: expanded() ? '▾' : '▸',
      }),
      jsx('text', {
        flexGrow: 1,
        fg: view.tones.base,
        children: (): string => {
          const n = count()
          const open = expanded()
          return open
            ? `${n} session${n === 1 ? '' : 's'}`
            : `${n} session${n === 1 ? '' : 's'}…  (expand)`
        },
      }),
    ],
  })
}
