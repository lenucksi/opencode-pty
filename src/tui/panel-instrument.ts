import { screenContent } from './lib.ts'
import { startScrollKeeper, type ScrollKeeper } from './scroll-keeper.ts'
import type { SessionPanelHostDeps } from './session-panel-host.ts'
import type { SessionPanelState } from './session-panel-state.ts'
import {
  noteSessionPanelInput,
  noteSessionPanelList,
  noteSessionScreen,
} from './session-panel-state.ts'
import { readScreen } from './server.ts'

/**
 * The panel's instrument readings, off by default (`PTY_TUI_DEBUG`).
 *
 * The module exists so the HOST file stays about decisions, not about counters: these
 * are the events a jump's log is read by. Each answers one measured question.
 */

type SetState = (mutate: (draft: SessionPanelState) => void) => void

/**
 * One poll tick's writes, plus the readings of both.
 *
 * Whether the LIST kept its identity across a tick (the merge's own rule) and whether
 * the SCREEN write changed content or only the clock are read after the write, which is
 * what the merge was built to preserve.
 */
export function noteListAndScreen(
  setState: SetState,
  deps: SessionPanelHostDeps,
  state: SessionPanelState,
  sessionID: string
): void {
  const listBefore = state.sessions
  const screenBefore = state.screen
  setState((draft) => {
    noteSessionPanelInput(draft, sessionID)
    noteSessionPanelList(draft, deps.panel.sessions, sessionID)
  })
  deps.debug('panel.list.note', {
    count: state.sessions.length,
    sameIdentity: state.sessions === listBefore,
    same: state.screen.text === screenBefore.text,
  })
}

/**
 * Read the selected session's screen, and say so in the panel when that fails.
 *
 * Writes through the state store handed in, so a test can watch it land rather than
 * read a log. The timing matters for the reading: the screen is compared against the
 * value captured BEFORE this tick's read, so `same` says whether the poll actually
 * changed the content or only re-read it.
 */
export async function readSelectedScreenInto(
  setState: SetState,
  deps: SessionPanelHostDeps,
  state: SessionPanelState,
  id: string
): Promise<void> {
  const origin = deps.origin()
  if (origin === null) return
  const now = Date.now()
  const before = state.screen
  try {
    const screen = await readScreen(origin, id)
    setState((draft) => noteSessionScreen(draft, screen, now))
    deps.debug('panel.screen.write', {
      id,
      same: before.text === screen.text,
      chars: screen.text.length,
    })
  } catch (error) {
    // Keep the last frame of THIS session. It is stale, not wrong - and blanking the
    // panel with an error every time the host is busy is what made a live htop flash
    // an AbortError instead of the process list. A different session gets the error,
    // because a screen that silently stayed on the previous process's output would
    // read as the panel tracking the wrong one.
    const belongsToSelection = before.text !== '' && state.selected === id
    if (!belongsToSelection) {
      setState((draft) =>
        noteSessionScreen(
          draft,
          screenContent(`(could not read the screen: ${String(error)})`),
          now
        )
      )
    }
    deps.debug('panel.screen.failed', {
      id,
      error: String(error),
      kept: belongsToSelection,
    })
  }
}

/** The claim's render counter, sampled: the cadence the reader's twitch lived in. */
export function createClaimMeter(debug: SessionPanelHostDeps['debug']): () => void {
  let count = 0
  return () => {
    count += 1
    // One in twenty keeps the log small, and every twentieth names the cadence well
    // enough; the FIRST is logged too, because a jump needs a baseline.
    if (count % 20 === 1) debug('panel.claim.render', { n: count })
  }
}

/**
 * The console's scrollable keeper, wired with its two readings.
 *
 * `attach` more than once means the console frame's widget was rebuilt (the reader's
 * scroll cannot survive that); a tick reading carries the pose BEFORE the decision
 * applied, so a `stickyScroll` that flips back without an attach names the tree's own
 * re-assert.
 */
export function createConsoleKeeper(
  debug: SessionPanelHostDeps['debug'],
  onWidth?: (width: number) => void
): ScrollKeeper {
  let attach = 0
  let lastWidth = 0
  const report = (width: number | undefined): void => {
    if (width === undefined || width === lastWidth) return
    lastWidth = width
    onWidth?.(width)
  }
  return startScrollKeeper({
    onAttach: () => {
      attach += 1
      debug('panel.console.attach', { n: attach })
    },
    onTick: (reading) => {
      debug('panel.console.tick', reading)
    },
    onWidth: report,
  })
}
