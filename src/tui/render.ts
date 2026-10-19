import type { MouseEvent } from '@opentui/core'
import { jsx } from '@opentui/solid/jsx-runtime'

import { parentSessionGroupTitle } from '../web/shared/session-meta.ts'
import {
  archiveLabel,
  clearActionLabel,
  finishedSessions,
  headerLabel,
  type PanelSession,
  ROW_BULLET,
  rowTail,
  rowTone,
} from './lib.ts'
import {
  emptyListLabel,
  finishedRows,
  failureCount,
  filterChipLabel,
  GROUP_AUTO_OPEN_LIMIT,
  isGroupOpen,
  type PanelGroup,
  sessionCountLabel,
} from './panel-state.ts'

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

import type { Tones } from './tones.ts'

export interface PanelView {
  readonly tones: Tones
  readonly collapsed: boolean
  readonly status: string
  /**
   * Every session the server reported, in display order.
   *
   * The counts and the clear control read THIS, not `groups`: a count that described the
   * visible rows would report 3 while the archive holds 200, and a clear that acted
   * on the visible rows would silently keep the other 197.
   */
  readonly sessions: readonly PanelSession[]
  /**
   * The groups to draw, already filtered and ordered by the wiring.
   *
   * Built by `groupsForDisplay` over what `visibleSessions` selected, so a group holding
   * nothing running appears only while the archive expansion is open, and one the query
   * emptied is gone rather than drawn as an empty heading.
   */
  readonly groups: readonly PanelGroup[]
  /**
   * The parent conversations' titles, by id, for the group headings.
   *
   * Resolved by the wiring from the host's own session list rather than requested: a
   * conversation can be gone while its archived session remains, and the heading must then
   * fall back through `parentSessionGroupTitle` instead of vanishing.
   */
  readonly titles: Readonly<Record<string, string>>
  /** The active filter, echoed where an empty list has to explain itself. */
  readonly filter: string
  /** The group keys the reader has folded shut. */
  readonly collapsedGroups: readonly string[]
  /** Whether the footer has asked for the failed finished rows. */
  readonly showFinished: boolean
  /** Fold or unfold one group's rows. */
  readonly onToggleGroup: (key: string) => void
  /** Clear the active filter. */
  readonly onClearFilter: (event: MouseEvent) => void
  /** Expand/collapse the header. */
  readonly onToggle: (event: MouseEvent) => void
  /** Show or hide the failed finished rows. */
  readonly onToggleArchive: (event: MouseEvent) => void
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
    wrapMode: 'none',
    flexShrink: 0,
    children: ROW_BULLET,
  })
  const label = jsx('text', {
    fg: view.tones.base,
    // The TITLE alone grows and shrinks, and never wraps: a wrapped row is two rows, and a list of
    // them stops being a list (measured: the tail landed on its own line below 30 columns).
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    wrapMode: 'none',
    truncate: true,
    children: session.title && session.title.length > 0 ? session.title : 'untitled',
  })
  // The state is its own element, fixed, because it is the reason the row exists: cut the title
  // and the state survives, which one string cannot do (measured: `123456L` became `1`).
  const tail = jsx('text', {
    fg: view.tones.muted,
    wrapMode: 'none',
    flexShrink: 0,
    children: `  ${rowTail(session)}`,
  })
  const remove = jsx('text', {
    fg: view.tones.muted,
    // Never shrunk and never wrapped: a remove control that has moved to its own line is one
    // nobody finds.
    wrapMode: 'none',
    flexShrink: 0,
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
    // The row is clickable, and had NEVER been: only the remove glyph carried a handler, so
    // `onOpen` was unreachable from a row and the output could only be opened from the palette.
    // A reader reported it as "clicking a running session should open the panel too", which
    // was exactly right - the handler simply did not exist.
    //
    // UP, like the glyph beside it, for the same reason inverted: a click delivers both, so
    // acting on the DOWN as well would fire the open and then whatever the UP reaches.
    onMouseUp: (event: MouseEvent) => {
      event.stopPropagation()
      view.onOpen(session)
    },
    // DOWN only to stop it, never to act. Without this the panel's own header toggle - an
    // ancestor of the list - would collapse the section on the press half of every click.
    onMouseDown: (event: MouseEvent) => event.stopPropagation(),
    children: [bullet, label, tail, remove],
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
        // `onMouseDown` ONLY, and that is load-bearing. A click delivers both events,
        // so registering the toggle on each flipped the panel twice: it opened and
        // shut again within the same gesture, which looks like a panel that refuses
        // to open. The built-in sidebar headers register one handler for the same
        // reason.
        onMouseDown: toggle,
        // An accessor, so the status text follows the poll without the panel being
        // torn down and rebuilt.
        children: (): string => headerLabel({ collapsed: view.collapsed, status: view.status }),
      }),
      jsx('text', {
        fg: view.tones.muted,
        // The active filter, and the way to clear it that needs no typing. `onMouseDown` ONLY,
        // for the same reason as its neighbours: a click delivers both events, so registering
        // the clear on each would run it twice. Stopped so the press does not reach the header
        // toggle and collapse the section on the way.
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onClearFilter(event)
        },
        // Empty when nothing is filtered: a zero-width element presents no hit target, so the
        // header never offers a click that would clear nothing - the rule the clear control
        // above follows too.
        // A leading space only while it is drawn, so the segment does not open a gap for
        // nothing when no filter is set.
        children: (): string => {
          const chip = filterChipLabel(view.filter)
          return chip === '' ? '' : `  ${chip}`
        },
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

/**
 * One parent conversation's heading, with its fold control.
 *
 * The shape is the host MCP sidebar's, copied rather than invented: the chevron exists only
 * once a group is big enough for folding to save something, and `isGroupOpen` owns which
 * groups are open so the header and its rows cannot disagree.
 *
 * The heading is the shared `parentSessionGroupTitle` given the parent's title, and the
 * agent is the raw `parentAgent` the web sidebar shows - not a second format invented here.
 */
function groupHeaderFor(view: PanelView, group: PanelGroup, open: boolean) {
  const count = group.sessions.length
  const collapsible = count > GROUP_AUTO_OPEN_LIMIT
  const meta = [group.parentAgent, sessionCountLabel(count)].filter(Boolean).join('  ')
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    // Stop only, never act: the panel's own header - an ancestor of this list - toggles on
    // mouse-down, so a press on the heading's text would collapse the whole section. The
    // click that folds is the chevron's, and it is the only acting handler here.
    onMouseDown: (event: MouseEvent) => event.stopPropagation(),
    children: [
      // Rendered only where folding does something: a chevron on a group that cannot be
      // folded is a control with no answer, which is what the host's sidebar avoids too.
      ...(collapsible
        ? [
            jsx('text', {
              fg: view.tones.muted,
              // Fixed, or it shrinks to nothing first and the fold control disappears.
              wrapMode: 'none',
              flexShrink: 0,
              children: open ? '▼ ' : '▶ ',
              // ONE handler, on mouse-DOWN only. A click delivers a down AND an up, so a
              // toggle registered on each fired twice and the group looked like it ignored
              // the click - the `dde6ce3` regression class. The host MCP sidebar registers
              // one for the same reason.
              onMouseDown: (event: MouseEvent) => {
                event.stopPropagation()
                view.onToggleGroup(group.key)
              },
            }),
          ]
        : []),
      jsx('text', {
        fg: view.tones.base,
        // Grows so the agent and the count are pushed to the panel's right edge, shrinks first
        // when there is not room, and NEVER wraps: measured in a ~36-column sidebar, chevron (2)
        // + title (22) + meta (18) came to 42, the default wrap split the heading over two lines,
        // and the group stopped looking like one group.
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: 'none',
        truncate: true,
        children: parentSessionGroupTitle(group, view.titles),
      }),
      jsx('text', {
        fg: view.tones.muted,
        // Short, and the last thing that may give way: a count that is clipped reads as a
        // different count.
        wrapMode: 'none',
        flexShrink: 0,
        children: meta,
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
      if (view.groups.length === 0) {
        // Says what is true rather than showing an empty box, and names the query when one is
        // active: "nothing running" under a filter would claim no process is alive, which is a
        // different thing from the query having excluded them all.
        return [jsx('text', { fg: view.tones.muted, children: emptyListLabel(view.filter) })]
      }
      // One heading per parent conversation, then its rows while it is unfolded. The groups
      // arrive already ordered and filtered, so the fold decision here and the heading's
      // chevron read the same count.
      return view.groups.flatMap((group) => {
        const open = isGroupOpen(group.sessions.length, group.key, view.collapsedGroups)
        return [
          groupHeaderFor(view, group, open),
          ...(open ? group.sessions.map((session) => rowFor(view, session)) : []),
        ]
      })
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

/**
 * The footer contribution: one line carrying the archive's size.
 *
 * A separate slot rather than another header row, because the sidebar's bottom is the
 * one place a summary does not push the built-in items down - and the count is the
 * least interesting thing on the screen, so it should cost the least space.
 */
export function sidebarFooterView(view: PanelView) {
  return jsx('box', {
    width: '100%',
    children: jsx('text', {
      fg: view.tones.muted,
      // `onMouseDown` ONLY, for the same reason as the header: a click delivers both
      // events, so registering on each would toggle twice and appear to do nothing.
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation()
        view.onToggleArchive(event)
      },
      // An accessor, so the line follows the poll. Empty rather than a placeholder when
      // nothing is finished: a zero-width element presents no hit target, so the footer
      // never offers a click that would expand an empty list.
      children: (): string =>
        archiveLabel({
          finished: finishedSessions(view.sessions).length,
          failed: failureCount(view.sessions),
          shown: finishedRows(view.sessions).length,
          expanded: view.showFinished,
        }) ?? '',
    }),
  })
}

/** How many finished sessions a "clear finished" would act on, for reporting. */
export function clearTargetCount(sessions: readonly PanelSession[]): number {
  return finishedSessions(sessions).length
}
