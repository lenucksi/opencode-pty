import type { MouseEvent } from '@opentui/core'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createMemo, type Accessor } from 'solid-js'

import {
  formatDuration,
  isFinished,
  sessionIdentity,
  type PanelSession,
  sessionDurationMs,
} from './lib.ts'
import { horizontalBar, keyHints } from './console-chrome.ts'
import { listHeader, rowFor } from './session-list.ts'
import { screenNodes } from './screen-nodes.ts'
import type { Tones } from './tones.ts'
import type { ScrollCanvas } from './scroll-keeper.ts'
import { type SessionPanelState, selectedLive, visibleRows } from './session-panel-state.ts'

/**
 * The PTY panel inside a session: the processes THIS conversation started, with one of
 * them on screen.
 *
 * The placement is joint with the web UI in one throne: a session belongs beside the
 * conversation that commissioned it, in exactly that card.
 *
 * == The frame's shape
 *
 * The header and the folded list row are `flexShrink: 0` + `height: 1`, not assumed. The
 * console owns everything else; the reader reported a panel that sounded like a
 * full-screen dump of a few rows at minimum - the console collapsing to its minimum while
 * the ROWS of the list grew. For that, the list is folded - collapsed - by default, and
 * the console takes the rest (`flexGrow: 1` + `minHeight: 0`).
 *
 * == What is INSIDE the frame
 *
 * The console is a scrollbox with a scrollbar, sticky at the bottom, exactly as the panel
 * in `src/tui/session-panel-host.ts` renders and types it.
 */
export interface SessionPanelView {
  readonly tones: Tones
  readonly state: SessionPanelState
  /**
   * The fresh list, so the selected row's timer stops when the process does.
   *
   * An ACCESSOR, and that is structural: the claim's render must not read the poll's
   * store - every read there is tracked, and the poll writes per tick (`panel.sessions`
   * among them), so a plain value meant a re-run of the claim's whole render and a
   * freshly born console widget per tick. The reader measured that on the jump.
   */
  readonly live: () => readonly PanelSession[]
  /** True while the host has this panel focused. */
  readonly focused: boolean
  /** `fullscreen` when the reader asked for the whole screen. */
  readonly fullscreen: boolean
  /**
   * Close the panel.
   *
   * Not a convenience: the host has NO key for closing a plugin panel. All four
   * `panels.close()` call sites are side effects of something else - changing session,
   * selecting a terminal, opening the sidebar - so a plugin that opens a panel owes the
   * reader a way out of it. Ours has three: this control, a palette entry and a keybind.
   */
  readonly onClose: () => void
  /** Ask for a line and hand it to the selected process. */
  readonly onSend: (session: PanelSession) => void
  /** Move the console sideways, in cells. */
  readonly onScrollBy: (cells: number) => void
  readonly onSelect: (id: string) => void
  /** Fold the session list open or closed. The click on its header row. */
  readonly onToggleList: () => void
  /**
   * Hand over the console's scrollable, once the frame drew it.
   *
   * The keeper outside watches the reader's position against the poll; the view stays
   * a pure function of inputs and neither owns nor keeps the canvas.
   */
  readonly onConsoleCanvas?: (canvas: ScrollCanvas) => void
  /**
   * A conversation's title, for the line that names the process on screen.
   *
   * A resolver rather than a string, because the parent can be a conversation this project has
   * never opened - the sidebar lists PTYs from every project - and then there is no title to be had
   * and the line has to fall back to the stable id.
   */
  readonly parentName: (id: string | undefined) => string | undefined
}

/**
 * The whole panel: a header, this session's rows, and the selected session's screen.
 *
 * An accessor for everything that changes with the poll, so the panel updates in place
 * instead of being torn down and rebuilt - which is what keeps the reader's scroll
 * position and the host's focus where they were.
 */
/**
 * The panel's header: what it is showing, how to leave it, and for how long.
 *
 * `✕ close` is the middle item rather than a trailing glyph because it is the answer to
 * the question a reader has first - how do I get out - and a right-aligned control is the
 * last place a reader looks for it. Three exits exist in total (this, the palette entry
 * and `ctrl+y`); see `registerSessionPanelCloseCommand` for why the other two are needed.
 */
function panelHeader(view: SessionPanelView, chosen: () => PanelSession | null) {
  return jsx('box', {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    flexShrink: 0,
    gap: 2,
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
        // Only for a process that can still be written to: a control opening an input field
        // whose answer the server refuses is worse than no control at all.
        children: (): string => {
          const picked = chosen()
          return picked !== null && !isFinished(picked) ? '⌨ send' : ''
        },
        // On RELEASE, and that is load-bearing: a click delivers a mouse-down and a
        // mouse-up, and a dialog asked for on the down is closed by that same gesture's
        // up - by release time the host's dialog backdrop sits under the pointer and its
        // mouse-up handler dismisses it, which reads as a prompt that dies unless the
        // button is held. The toggles above stay on mousedown because they are toggles;
        // this opens once, and once is what the release belongs to.
        onMouseUp: (event: MouseEvent) => {
          event.stopPropagation()
          const picked = chosen()
          if (picked !== null && !isFinished(picked)) view.onSend(picked)
        },
      }),
      jsx('text', {
        fg: view.tones.muted,
        // ONE handler, and on mouse-down only: a click delivers a mouse-down AND a
        // mouse-up, so a toggle on each fires twice.
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation()
          view.onClose()
        },
        children: '✕ close',
      }),
      jsx('text', {
        fg: view.tones.muted,
        // The run timer of the selected session, in the header's right corner. Empty
        // rather than "0s" when the start cannot be read: a duration nobody can compute
        // should not be shown as none.
        children: (): string => {
          const picked = chosen()
          if (picked === null) return ''
          const ms = sessionDurationMs(picked, view.state.now)
          return ms === null ? '' : formatDuration(ms)
        },
      }),
    ],
  })
}

/**
 * The line above the console: which process is on screen.
 *
 * ABOVE the console rather than in the footer, because the console is scrolled content and the
 * identity of what is being scrolled has to be readable without scrolling to it. It is also the
 * answer a reader needs after clicking a row in the sidebar: the sidebar lists every project's
 * processes, so `started by ...` is how they learn whose process they landed on.
 *
 * Empty when nothing is selected, and then the row is not drawn at all - a blank line above an empty
 * panel is a row nobody can use.
 */
function identityLine(view: SessionPanelView, chosen: () => PanelSession | null): unknown {
  return jsx('box', {
    height: 1,
    flexShrink: 0,
    width: '100%',
    children: jsx('text', {
      fg: view.tones.base,
      // One line, always: the panel is wide but the line is long, and a wrapped identity pushes the
      // console down by a row for nothing.
      wrapMode: 'none',
      flexShrink: 1,
      children: (): string => {
        const picked = chosen()
        if (picked === null) return ''
        return sessionIdentity(picked, view.parentName(picked.parentSessionId))
      },
    }),
  })
}

/**
 * The footer: what is on screen, and how much of it.
 *
 * The same two lines the web UI draws - identifiers above, counters below - because a screen
 * with no numbers on it cannot answer "is this stale?" or "is that the process I think?".
 * Size and line count are the ones that matter for a full-screen program: `top` at 120x40
 * wrapped into 80 columns is not a rendering fault but a different program running.
 */
function statusBar(view: SessionPanelView, chosen: () => PanelSession | null): unknown {
  return jsx('text', {
    width: '100%',
    fg: view.tones.muted,
    children: (): string => {
      const picked = chosen()
      if (picked === null) return ''
      const size =
        picked.cols === undefined || picked.rows === undefined
          ? ''
          : `  ${picked.cols}x${picked.rows}`
      const rows = view.state.screen.text === '' ? 0 : view.state.screen.text.split('\n').length
      return [
        `${picked.id}  ${picked.status ?? '?'}${size}`,
        `lines ${picked.lineCount ?? '?'}  screen ${rows} rows`,
      ].join('  ·  ')
    },
  })
}

/**
 * The framed console, or nothing at all while no session is selected.
 *
 * Returns undefined rather than an empty box: an empty frame is a large black rectangle
 * that says nothing, and right next to the sentence explaining why there is nothing, it
 * reads as a rendering failure rather than as an absence.
 *
 * The console is why the panel exists, which is why it owns EVERY row the panel has left
 * rather than a computed share: `flexGrow: 1` with `minHeight: 0` under everything fixed
 * (`header`, the list toggle and the footer each declare `flexShrink: 0`), so a longer
 * list costs the console nothing a shorter one does not and the console never ends up
 * shorter than the panel can afford. Computed heights were an earlier attempted fix and
 * the record of that remains in `eabb802`: `renderer.height` is the TERMINAL's height,
 * not the panel's.
 *
 * A scrollbox rather than the box-plus-`overflow` the file used before opentui 0.6.6,
 * and the choice carries two measured facts with it:
 *
 * - In 0.5.14 a scrollbox posed `stickyScroll: true` + `stickyStart: 'bottom'` rendered
 *   NOTHING when its text contains a line break, so the old box was correct then - and
 *   it showed the OLDEST screen rows because it clips from the top. Measured: a console
 *   25 rows tall inside 6 rows of panel drew `k01`… and cut `k29`, the line the reader
 *   had just run.
 * - From 0.6.6 the same pose draws the newest with a scrollbar. The panel does not slide
 *   its own offset and does not truncate `screen` with `tail`; the full dump stays in the
 *   tree and the widget scrolls it - which is what a reader means by "die Konsole."
 */
function framedScreen(view: SessionPanelView): unknown {
  return jsx('box', {
    width: '100%',
    flexGrow: 1,
    minHeight: 0,
    border: true,
    borderStyle: 'single',
    borderColor: view.tones.border,
    backgroundColor: view.tones.raised,
    children: jsx('scrollbox', {
      flexGrow: 1,
      minHeight: 0,
      stickyScroll: true,
      stickyStart: 'bottom',
      scrollX: true,
      // The horizontal bar is opentui's own and appears by itself once the content is
      // wider than the viewport. The arrows would eat three columns of a 40-column
      // sidebar, so they are off: the bar is a position indicator, and the reader
      // scrolls with the wheel or the keyboard.
      horizontalScrollbarOptions: { showArrows: false },
      // Hand the scrollable to the host once it exists: the keeper outside decides
      // from the reader's position whether the next poll may drag the view, and the
      // view itself stays a pure function of what it is told.
      ref: (value: ScrollCanvas) => view.onConsoleCanvas?.(value),
      children: jsx('box', {
        flexDirection: 'column',
        width: '100%',
        children: (): unknown[] =>
          screenNodes(view.state.screen, view.state.scrollLeft, view.state.consoleWidth),
      }),
    }),
  })
}

/**
 * The session list, folded by default.
 *
 * Its children are computed INSIDE the accessor: a list change re-rows the list, and
 * nothing else - the console outside it cannot hear the write.
 */
function listBlock(
  view: SessionPanelView,
  sessions: Accessor<PanelSession[]>,
  expanded: Accessor<boolean>
): unknown {
  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    flexShrink: 0,
    children: (): unknown[] => {
      const group = sessions()
      const open = expanded()
      const head = listHeader(view, sessions, expanded)
      if (group.length === 0) {
        return [
          head,
          jsx('text', {
            fg: view.tones.muted,
            children: '   this conversation started no PTY session',
          }),
        ]
      }
      const { rows, overflow } = visibleRows(group, open)
      const entries: unknown[] = [head, ...rows.map((session) => rowFor(view, session))]
      if (overflow > 0) {
        entries.push(
          jsx('text', {
            width: '100%',
            flexShrink: 0,
            fg: view.tones.muted,
            children: (): string => '   \u2026 and ' + String(overflow) + ' more in the sidebar',
          })
        )
      }
      return entries
    },
  })
}

export function sessionPanelView(view: SessionPanelView) {
  // Memos, so the claim's render never TRACKS the poll's store: every read of these was
  // going into the render scope before, and the poll writes per tick - the reader saw
  // the whole tree rebuilt, and the console's scrollbox was a freshly born widget with
  // it, yanking their scroll to the bottom. The memos own their reads instead.
  const chosen = createMemo(() => selectedLive(view.state, view.live()))
  const sessions = createMemo(() => view.state.sessions)
  const expanded = createMemo(() => view.state.listExpanded)

  const header = panelHeader(view, chosen)

  const list = listBlock(view, sessions, expanded)

  // The console's slice: identity line above the frame, both absent while nothing is
  // selected. Reading `chosen` inside the accessor keeps a poll from re-running this
  // block, so the scrollbox persists across ticks and the reader's scroll holds.
  const screenBlock = jsx('box', {
    flexDirection: 'column',
    width: '100%',
    minHeight: 0,
    children: (): unknown[] => {
      // Gated by the SELECTION, not by `chosen`: `selected` is exactly what the poll's
      // `noteSessionSelected` writes and the spot the frame relied on before.
      if (view.state.selected === null) return []
      return [identityLine(view, chosen), framedScreen(view), horizontalBar(view)]
    },
  })

  // The footer LAST, and `flexShrink: 0`: the framed screen above it grows to fill, so a
  // bar inside the frame would be pushed off the bottom by its own content.
  // Two rows when the panel is focused (the counters and the key hints), one
  // otherwise: a hint row that is always there would cost the console a row for
  // readers who cannot use the keys anyway.
  const footer = jsx('box', {
    flexDirection: 'column',
    width: '100%',
    height: 'auto',
    flexShrink: 0,
    children: [
      statusBar(view, chosen),
      ...(view.focused
        ? [
            jsx('text', {
              width: '100%',
              fg: view.tones.muted,
              children: keyHints(view),
            }),
          ]
        : []),
    ],
  })
  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    flexGrow: 1,
    minHeight: 0,
    // Two columns of air on the left, measured against the reader's own screenshot:
    // the glyphs used to start ON the overlay's edge, and a drag starting there
    // kept landing on the terminal UNDERNEATH the panel. The inset is inside the
    // surface, so the pointer first hits the panel's own background.
    paddingLeft: 2,
    children: [header, screenBlock, list, footer],
  })
}
