import type { Plugin } from '@opencode/plugin/tui'

import { isFinished, type PanelSession } from './lib.ts'
import type { PanelState } from './panel-state.ts'
import type { Tones } from './tones.ts'
import {
  createClaimMeter,
  createConsoleKeeper,
  noteListAndScreen,
  readSelectedScreenInto,
} from './panel-instrument.ts'
import type { ScrollKeeper } from './scroll-keeper.ts'
import { sessionPanelView } from './session-panel.ts'
import {
  initialSessionPanelState,
  noteSessionListToggled,
  noteScopeChosen,
  noteSessionSelected,
  selectedSession,
  type SessionPanelState,
} from './session-panel-state.ts'

/** The state store's key this panel restores from. */
const SESSION_PANEL_KEY = 'opencode-pty.session-panel'

const SESSION_PANEL_NAME = 'opencode-pty'

/**
 * What the claim learns from its input, for the commands that need it.
 *
 * The ceiling is measured, not chosen: the keymap hangs off the RENDERER, and the host
 * handles "a focused editor owns the input" by enabling a layer rather than by letting a
 * renderable swallow the key. So `ctrl+y` closes and `f3` enlarges.
 */
export interface PanelActions {
  /** The claim's `toggleFullscreen`, once it has rendered. Absent before the first render. */
  toggleFullscreen?: () => void
}

export interface SessionPanelHostDeps {
  readonly context: Plugin.Context
  /** The panel's live state: read, never mutated here. */
  readonly panel: PanelState
  readonly tones: () => Tones
  /** Re-list. force for a refresh the user is waiting on. */
  readonly refresh: (mayStart?: boolean, force?: boolean) => Promise<void>
  readonly debug: (event: string, detail?: unknown) => void
  /** Where the plugin's own server is listening, resolved wherever it was filed. */
  readonly origin: () => string | null
  /** Hand a line to the selected process. */
  readonly sendInput: (session: PanelSession) => Promise<void>
}

export interface SessionPanelHost {
  /** The poll's half: read the fresh state, list, and screen. */
  sync: () => Promise<void>
  register: () => void
  registerClose: () => void
  /** Open the panel on a given session (the sidebar's click path). */
  openWith: (session: PanelSession) => void
}

/**
 * Everything about the PANEL that touches the host: the store, the poll hook, the slot
 * claim, and the commands a reader has while it is open.
 */
export function createSessionPanelHost(deps: SessionPanelHostDeps): SessionPanelHost {
  const { context } = deps
  const [state, setState] = context.storage.memory<SessionPanelState>(SESSION_PANEL_KEY, {
    initial: initialSessionPanelState(),
  })

  const readSelectedScreen = (id: string): Promise<void> =>
    readSelectedScreenInto(setState, deps, state, id)

  const sync = async (): Promise<void> => {
    const active = context.ui.panel.current()
    // Both halves matter: no panel means nothing to do, and a panel of ANOTHER name
    // means this plugin must not read a screen because somebody else is on screen.
    if (active === undefined || active.name !== SESSION_PANEL_NAME) return
    const sessionID = active.sessionID
    noteListAndScreen(setState, deps, state, sessionID)
    const chosen = selectedSession(state)
    if (chosen === null) return
    await readSelectedScreen(chosen.id)
  }

  // The instrument lives in panel-instrument.ts; both halves only run with
  // PTY_TUI_DEBUG, and counters are the last thing a decision file should carry.
  const keeper: ScrollKeeper = createConsoleKeeper(deps.debug)
  const countClaimRender = createClaimMeter(deps.debug)

  const select = (id: string): void => {
    setState((draft) => noteSessionSelected(draft, id))
    // Re-arm on a fresh selection: the reader starts at the bottom of a session they
    // have not read.
    keeper.arm()
  }

  const panel: PanelActions = {}

  /** Dropping a scope a click set, so the panel means this conversation again. */
  const resetScope = (): void => setState((draft) => noteScopeChosen(draft, null))

  const register = (): void => {
    claimSessionPanel(context, deps, state, select, sync, panel, keeper, countClaimRender)
    registerSessionPanelCommand(context, deps, resetScope)
  }

  const registerClose = (): void => registerSessionPanelCommands(context, panel, deps, state)

  const openWith = (session: PanelSession): void => {
    setState((draft) => {
      noteScopeChosen(draft, session.parentSessionId ?? null)
      noteSessionSelected(draft, session.id)
    })
    // A freshly opened panel shows a session the reader has not read: its bottom row
    // comes first, so the keeper is armed rather than left where the previous
    // selection's scroll left it.
    keeper.arm()
    context.ui.panel.open(SESSION_PANEL_NAME)
    // The screen is read on the poll, so the panel opens showing the SELECTED row rather
    // than the previous one's output until the next tick.
    void sync()
  }

  return { sync, register, registerClose, openWith }
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
  panel: PanelActions,
  keeper: ScrollKeeper,
  /** Counts one claim render; the instrument reads its cadence. */
  renderMeter: () => void
): void {
  context.ui.slot({
    append: 'session.panel',
    render: (input) => {
      // Recorded on every render rather than once: the host builds this input itself and
      // hands over a fresh one whenever the panel is re-opened.
      panel.toggleFullscreen = input.toggleFullscreen
      renderMeter()
      return sessionPanelView({
        tones: deps.tones(),
        // The STORE itself, not a copy: a spread in a reactive render scope reads EVERY
        // field of the store, so any poll tick's write re-laid the panel out - which is
        // the twitch the reader measured. Accessors read fields lazily instead.
        state,
        // The accessor keeps the poll's list read OUT of this render scope: a read here
        // is tracked, the poll writes per tick, and the claim's whole tree was being
        // rebuilt with a freshly born console widget inside it per tick.
        live: () => deps.panel.sessions,
        focused: input.focused,
        fullscreen: input.presentation === 'fullscreen',
        onClose: input.close,
        // The parent may be a conversation this project never opened, so the lookup
        // answers nothing and the line falls back to the id.
        parentName: (id) => (id === undefined ? undefined : context.data.session.get(id)?.title),
        onSend: deps.sendInput,
        onSelect: (id) => {
          select(id)
          void sync()
        },
        onToggleList: () => noteSessionListToggled(state),
        onConsoleCanvas: (canvas) => keeper.attach(canvas),
      })
    },
  })
}

/**
 * The command that opens the panel: a palette entry, a slash command, and no keybind.
 *
 * A keybind is deliberately NOT configured: any guess could collide with the host's
 * own. The command has an id, so it can be bound in the user's keymap config.
 */
function registerSessionPanelCommand(
  context: Plugin.Context,
  deps: SessionPanelHostDeps,
  /** Drops a scope a click set: opening from the palette means THIS conversation. */
  resetScope: () => void
): void {
  context.keymap.layer(() => ({
    // `global`, so the command answers outside the prompt too.
    mode: 'global',
    commands: [
      {
        id: 'opencode-pty.session-panel',
        title: 'PTYs of this session',
        description: 'The processes this conversation started, with one of them on screen.',
        group: 'opencode-pty',
        palette: true,
        slash: { name: 'pty-sessions' },
        run: () => {
          resetScope()
          context.ui.panel.open(SESSION_PANEL_NAME)
          // Opening is a request to see the sessions, exactly like expanding the sidebar,
          // so it is a trigger that may start the server.
          void deps.refresh(true)
        },
      },
    ],
  }))
}

/**
 * The commands a reader has while the panel is open: leave it, enlarge it, or leave for
 * the session list. `ctrl+y` closes and `f3` enlarges, measured free.
 */
function registerSessionPanelCommands(
  context: Plugin.Context,
  panel: PanelActions,
  deps: SessionPanelHostDeps,
  state: SessionPanelState
): void {
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
        run: () => panel.toggleFullscreen?.(),
      },
      {
        id: 'opencode-pty.session-panel.send',
        title: 'Send a line to the selected PTY',
        description: 'Type one line for the program on screen, delivered as if typed.',
        group: 'opencode-pty',
        palette: true,
        bind: 'f4',
        enabled: () => {
          const chosen = selectedSession(state)
          return open() && chosen !== null && !isFinished(chosen)
        },
        run: () => {
          const chosen = selectedSession(state)
          if (chosen === null) return false
          void deps.sendInput(chosen).catch(() => {})
          return false
        },
      },
      {
        // No key, deliberately: the host's `session.list` is the way to switch
        // conversation, and a binding here would shadow it for no gain.
        id: 'opencode-pty.session-panel.sessions',
        title: 'Leave the PTY panel for the session list',
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
