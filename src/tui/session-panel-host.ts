import type { Plugin } from '@opencode/plugin/tui'

import type { PanelState } from './panel-state.ts'
import type { Tones } from './render.ts'
import { readScreen } from './server.ts'
import {
  initialSessionPanelState,
  noteSessionPanelInput,
  noteSessionPanelList,
  noteSessionScreen,
  noteSessionSelected,
  selectedSession,
  sessionPanelView,
  type SessionPanelState,
} from './session-panel.ts'

/** Durable: which row is on screen, and for which session, is worth keeping. */
const SESSION_PANEL_KEY = 'opencode-pty.session-panel'

/**
 * The name this panel claims under `session.panel`, and the name the host reports back
 * from `ui.panel.current()`. They must be the same string: the poll matches on the latter,
 * and a mismatch would leave the panel open and permanently empty with nothing failing.
 */
const SESSION_PANEL_NAME = 'opencode-pty'

/**
 * Everything about the session panel that needs the HOST: its store, the poll hook that
 * keeps it in step, the slot claim and the command that opens it.
 *
 * A factory rather than four loose blocks in `index.ts`, because `index.ts` is the
 * plugin's wiring for the SIDEBAR and the file was over the size the linter allows - and
 * because "everything about the session panel" is a boundary worth being able to name.
 */
export interface SessionPanelHostDeps {
  readonly context: Plugin.Context
  /** The sidebar's live state: the panel's rows are a subset of this list. */
  readonly panel: PanelState
  readonly tones: () => Tones
  readonly debug: (event: string, detail?: unknown) => void
  /** The sidebar's refresh. Opening the panel asks for the sessions, like expanding it. */
  readonly refresh: (mayStart?: boolean, force?: boolean) => Promise<void>
  readonly origin: () => string | null
}

export interface SessionPanelHost {
  /** Called on the sidebar's poll tick; returns once the panel is in step. */
  readonly sync: () => Promise<void>
  /** Registers the slot claim and the command that opens the panel. */
  readonly register: () => void
  /** Registers the command that closes it again. */
  readonly registerClose: () => void
}

export function createSessionPanelHost(deps: SessionPanelHostDeps): SessionPanelHost {
  const { context } = deps
  const [state, setState] = context.storage.memory<SessionPanelState>(SESSION_PANEL_KEY, {
    initial: initialSessionPanelState(),
  })

  /**
   * Read the selected session's screen, and say so in the panel when that fails.
   *
   * Separate from `sync` because it is the half that does I/O: a poll that does nothing
   * when the panel is closed should not look like the same function as one that waits on
   * a request, and a long function that mixes the two is the one nobody reads.
   */
  const readSelectedScreen = async (id: string): Promise<void> => {
    const origin = deps.origin()
    if (origin === null) return
    const now = Date.now()
    try {
      const screen = await readScreen(origin, id)
      setState((draft) => noteSessionScreen(draft, screen, now))
    } catch (error) {
      // Said in the panel rather than only in the log: a screen that silently stayed on
      // the previous session's output would read as the panel tracking the wrong process.
      setState((draft) =>
        noteSessionScreen(draft, `(could not read the screen: ${String(error)})`, now)
      )
      deps.debug('panel.screen.failed', { id, error: String(error) })
    }
  }

  const sync = async (): Promise<void> => {
    const active = context.ui.panel.current()
    // Both halves matter: no panel means nothing to do, and a panel of ANOTHER name means
    // this plugin must not read a screen because somebody else is on screen. The SDK
    // documents `current()` as "this plugin's active panel", so the name check is
    // defensive - and it is covered by a test so it does not get dropped as such.
    if (active === undefined || active.name !== SESSION_PANEL_NAME) return
    const sessionID = active.sessionID
    setState((draft) => {
      noteSessionPanelInput(draft, sessionID)
      noteSessionPanelList(draft, deps.panel.sessions, sessionID)
    })
    const chosen = selectedSession(state)
    if (chosen === null) return
    await readSelectedScreen(chosen.id)
  }

  // Own the write, so the claim above can be a plain function instead of a closure over
  // the store: `deps.select` is the one way this host changes the selection.
  // The one place this host changes the selection, kept as a local so the claim below can
  // be a plain function that receives it rather than a closure over the store.
  const select = (id: string): void => setState((draft) => noteSessionSelected(draft, id))

  const register = (): void => {
    claimSessionPanel(context, deps, state, select, sync)
    registerSessionPanelCommand(context, deps)
  }

  const registerClose = (): void => registerSessionPanelCloseCommand(context)

  return { sync, register, registerClose }
}

/**
 * The `session.panel` claim: the host's own place for an extra view of a session, where
 * Review and Files already live, and where a process belongs - next to the conversation
 * that started it.
 */
function claimSessionPanel(
  context: Plugin.Context,
  deps: SessionPanelHostDeps,
  state: SessionPanelState,
  select: (id: string) => void,
  sync: () => Promise<void>
): void {
  context.ui.slot({
    append: 'session.panel',
    render: (input) =>
      sessionPanelView({
        tones: deps.tones(),
        // The slot input is the authority on which session this is. A render must not
        // write state, so the view is handed a copy carrying the id and the poll does the
        // bookkeeping.
        state: { ...state, sessionID: input.sessionID },
        live: deps.panel.sessions,
        focused: input.focused,
        fullscreen: input.presentation === 'fullscreen',
        onClose: input.close,
        onSelect: (id) => {
          select(id)
          void sync()
        },
      }),
  })
}

/**
 * The command that opens the panel: a palette entry, a slash command, and no keybind.
 *
 * A keybind is deliberately NOT configured: any guess could collide with the host's own,
 * and a collision is discovered by the user pressing the wrong thing. The command has an
 * id, so it can be bound in the user's keymap config, and until then the palette entry and
 * the slash command reach it.
 */
function registerSessionPanelCommand(context: Plugin.Context, deps: SessionPanelHostDeps): void {
  context.keymap.layer(() => ({
    // `global`, so the command answers outside the prompt too - the panel is not a prompt
    // feature and its reader may well be somewhere else.
    mode: 'global',
    commands: [
      {
        id: 'opencode-pty.session-panel',
        title: 'PTYs of this session',
        description: 'The processes this conversation started, with one of them on screen.',
        group: 'opencode-pty',
        palette: true,
        // `pty-sessions` rather than `pty`: a bare `pty` would be a name another plugin
        // may already have claimed in the same completion list.
        slash: { name: 'pty-sessions' },
        run: () => {
          context.ui.panel.open(SESSION_PANEL_NAME)
          // Opening is a request to see the sessions, exactly like expanding the sidebar,
          // so it is a trigger that may start the server. Without it the panel would be
          // empty on a host where nothing else ever asked for one.
          void deps.refresh(true)
        },
      },
    ],
  }))
}

/**
 * The command that closes the panel again.
 *
 * The host has NO binding for closing a plugin panel. All four `panels.close()` call sites
 * are side effects of something else - changing session, selecting a terminal, opening the
 * sidebar - so a plugin that opens a panel owes its reader a way out of it. Without this,
 * `/pty-sessions` opened a panel with no exit: the thing one presses to leave it went
 * nowhere, and the only remaining move was killing the terminal. Measured, not inferred -
 * and the first version of this panel shipped exactly that trap.
 *
 * Three exits, because each covers a case the others do not:
 *
 * - the palette entry is guaranteed: it is a host overlay, which no plugin can shadow, so
 *   it works even while this panel holds focus and the composer is unreachable;
 * - `bind` is the shortcut for the mouse-free case, on a key measured free in
 *   packages/tui/src/config/keybind.ts. This is the one deliberate departure from the
 *   opening command above, which binds nothing: there, a binding would only duplicate two
 *   routes that already work, and a wrong guess collides with a host command. Here the
 *   reader has nowhere else to go. The command's id lets the user move or drop it;
 * - the `✕ close` control in the panel header, for the same reason by mouse.
 *
 * `enabled` keeps the key from lying: a binding that does nothing the rest of the time
 * teaches the reader to distrust the one time it matters.
 */
function registerSessionPanelCloseCommand(context: Plugin.Context): void {
  context.keymap.layer(() => ({
    mode: 'global',
    commands: [
      {
        id: 'opencode-pty.session-panel.close',
        title: 'Close the PTY panel',
        description: 'Leave the PTY panel and go back to the conversation.',
        group: 'opencode-pty',
        palette: true,
        bind: 'ctrl+y',
        enabled: () => context.ui.panel.current() !== undefined,
        run: () => context.ui.panel.close(),
      },
    ],
  }))
}
