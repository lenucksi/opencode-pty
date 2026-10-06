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

  // What the claim learned from its input, for the commands that need it.
  const panel: PanelActions = {}

  const register = (): void => {
    claimSessionPanel(context, deps, state, select, sync, panel)
    registerSessionPanelCommand(context, deps)
  }

  const registerClose = (): void => registerSessionPanelCommands(context, panel)

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
  sync: () => Promise<void>,
  panel: PanelActions
): void {
  context.ui.slot({
    append: 'session.panel',
    render: (input) => {
      // Recorded on every render rather than once: the host builds this input itself and
      // hands over a fresh one whenever the panel is re-opened, so a reference kept from the
      // first render would belong to the previous panel and toggle that one.
      panel.toggleFullscreen = input.toggleFullscreen
      return sessionPanelView({
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
      })
    },
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
 * What the panel claim learned from its input, for the commands that need it.
 *
 * Mutable and owned by the host, because the only source is the slot's render: a render must
 * not write state, so it records the function it was given and the poll does the bookkeeping.
 */
export interface PanelActions {
  /** The claim's `toggleFullscreen`, once it has rendered. Absent before the first render. */
  toggleFullscreen?: () => void
}

/**
 * The commands a reader has while the panel is open: leave it, enlarge it, or leave for the
 * session list. Those three and nothing else.
 *
 * The ceiling is measured, not chosen. The keymap hangs off the RENDERER
 * (`createDefaultOpenTuiKeymap(renderer)`, packages/tui/src/context/keymap.tsx:66), and the
 * host handles "a focused editor owns the input" by enabling a layer
 * (`registerManagedTextareaLayer`) rather than by letting a renderable swallow the key - so a
 * focused panel does not eat keys, and a bound command does reach us. What is scarce is the
 * KEYS: 167 binds are taken in packages/tui/src/config/keybind.ts. `escape` is
 * `session.interrupt`, and `q` is `diff.close`, whose command carries no `enabled` predicate
 * and so is reachable at any time. Both were the obvious choices for "leave this", and both
 * would have been wrong.
 *
 * So `ctrl+y` closes and `f3` enlarges, each measured free, and each also has a palette entry
 * - the route that cannot be taken away, because the palette is a host overlay no plugin can
 * shadow, so it answers even while the panel holds focus. The ids let the user move either
 * key. `enabled` keeps a key from lying: a binding that does nothing the rest of the time
 * teaches the reader to distrust the one time it matters.
 *
 * Switching sessions needs no key of ours. The host has `session.list` on `<leader>l` and
 * closes this panel as a side effect of leaving the session, so a key here would only shadow a
 * binding that already exists and works. The command exists for the same reason the close
 * command does: the reader is in the panel, and the routes out should be listed where they
 * can be found.
 */
function registerSessionPanelCommands(context: Plugin.Context, panel: PanelActions): void {
  const open = (): boolean => context.ui.panel.current() !== undefined
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
        enabled: open,
        run: () => context.ui.panel.close(),
      },
      {
        id: 'opencode-pty.session-panel.fullscreen',
        title: 'Enlarge the PTY panel',
        description: 'Give the PTY panel the whole window, or give the conversation its half back.',
        group: 'opencode-pty',
        palette: true,
        bind: 'f3',
        enabled: open,
        // `ui.panel` is only `open`, `close` and `current` - `toggleFullscreen` exists on
        // `PanelInput`, which arrives inside the slot's render and nowhere else. So the claim
        // leaves the function it was handed in `panel`, and the key drives that.
        run: () => panel.toggleFullscreen?.(),
      },
      {
        // No key, deliberately: the host's `session.list` is the way to switch conversation,
        // and a binding here would shadow it for no gain.
        id: 'opencode-pty.session-panel.sessions',
        title: 'Leave the PTY panel for the session list',
        // The panel belongs to one conversation, so leaving it for the session list means
        // leaving it altogether - and closing first is required, because the host closes a
        // panel only when the route changes to a DIFFERENT SESSION (app.tsx:596). Navigating
        // home is not that, and would leave the panel open on top of the list.
        description: 'Close the PTY panel and open the session list.',
        group: 'opencode-pty',
        palette: true,
        enabled: open,
        run: () => {
          context.ui.panel.close()
          context.ui.router.navigate({ type: 'home' })
        },
      },
    ],
  }))
}
