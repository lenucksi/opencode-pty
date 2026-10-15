import { Plugin } from '@opencode/plugin/tui'
import { countSessions } from '../web/shared/session-search.ts'
import { createActions } from './actions.ts'
import { debug } from './debug.ts'
import { registerFilterCommand } from './filter-command.ts'
import { type PanelSession, resolveParentTitles } from './lib.ts'
import {
  groupsForDisplay,
  initialPanelState,
  MAX_START_FAILURES,
  noteListSuccess,
  noteNoServer,
  noteStartError,
  noteUnreachable,
  type PanelState,
  sessionCountForHeader,
  statusWhenUnavailable,
  visibleSessions,
} from './panel-state.ts'
import { type PanelView, sidebarFooterView, sidebarView } from './render.ts'
import { isHealthy, listSessions } from './server.ts'
import { createOriginFinder, projectKeys } from './origin.ts'
import { createSessionPanelHost } from './session-panel-host.ts'
import {
  fillMissingPrefs,
  initialSidebarPrefs,
  SIDEBAR_PREFS_KEY,
  setFilter,
  toggleGroup,
} from './sidebar-prefs.ts'
import { PtyServerRpc } from '../v2/rpc.ts'

/**
 * The PTY sidebar: this project's PTY sessions, listed where the built-in sidebar
 * items live, with their live output in a dialog.
 *
 * ## Why a panel at all
 *
 * The web UI has its own page. The TUI has no equivalent, and a session a model
 * started is invisible there: the terminal shows the chat, not the processes. The
 * panel is how a human sees that `bun run dev` came up, has been up four minutes,
 * and just printed an error.
 *
 * ## Why the state lives in the host's store
 *
 * Two reasons, and neither is that a plugin-local signal would not work - it would.
 * The host registers a runtime module map that rewrites `solid-js` and
 * `@opentui/solid` onto the modules it has already loaded, so a signal created here
 * is live. (Outside the host it is not: a plain `bun` process resolves `solid-js`
 * through the `node` export condition to a build where reactivity is a no-op, which
 * is why a probe run in one will happily tell you the wrong thing.)
 *
 * What decided it: `context.storage` survives a plugin hot reload with the old and
 * new generation sharing one store, so an edited panel does not lose the list it was
 * showing; and it keeps every dynamic part an accessor over a host-owned value, which
 * is what lets the render stay a pure function of its inputs and be tested headlessly.
 *
 * ## Why the panel polls
 *
 * The web UI gets a WebSocket push. A TUI has no equivalent here, so the list is
 * polled, and `POLL_MS` is the floor for how stale the panel may look.
 *
 * This file is the wiring and nothing else. `server.ts` speaks HTTP,
 * `panel-state.ts` holds every state transition, `actions.ts` holds what a person
 * can do, `render.ts` draws, `lib.ts` decides what a row says.
 */

const POLL_MS = 2500
/**
 * Ephemeral: the list is this process's view of a server that can restart on a new
 * port, and a persisted copy would come back stale on the next start - which looks
 * like a bug rather than a remembered snapshot. It does survive a hot reload, which
 * is the case that actually bites.
 */
const PANEL_KEY = 'opencode-pty.sidebar.panel'

export default Plugin.define({
  id: 'opencode-pty',
  setup(context: Plugin.Context) {
    const [panel, setPanel] = context.storage.memory<PanelState>(PANEL_KEY, {
      initial: initialPanelState(),
    })
    const [prefs, setPrefs] = context.storage.store(SIDEBAR_PREFS_KEY, {
      initial: initialSidebarPrefs(),
    })
    // A store written by an earlier build carries only the keys that existed then, and the host
    // restores it AS IT WAS rather than merging `initial` into it. Repaired before anything reads
    // a preference: a missing `filter` is not a missing value but a crash - it reached
    // `normalizeQuery`, `query.trim()` threw, and the whole `sidebar.content` slot went down on
    // every render.
    setPrefs((draft) => fillMissingPrefs(draft))

    let disposed = false
    let refreshing = false
    let startPending = false
    let relistPending = false

    const notify = (message: string, variant: 'info' | 'warning' | 'error'): void => {
      try {
        context.ui.toast.show({ title: 'opencode-pty', message, variant })
      } catch (_) {
        /* a toast is best-effort; failing to show one must not fail the action */
      }
    }

    /**
     * The theme slots this plugin draws with, named rather than typed.
     *
     * One place, because the sidebar, its dialog and the session panel all need them,
     * and three copies of a palette is three places for a rename to miss.
     */
    const tones = () => ({
      base: context.theme.text.base,
      muted: context.theme.text.muted,
      success: context.theme.text.feedback.success.base,
      error: context.theme.text.feedback.error.base,
      border: context.theme.border.base,
      raised: context.theme.background.raised.base,
    })

    /**
     * The app's default location, which is where a server that `autostart` started files its
     * record.
     *
     * Best-effort: a host that cannot name its default means one fewer key to try, which must not
     * take the poll down.
     */
    const defaultLocation = (): string | undefined => {
      try {
        return context.data.location.default().directory
      } catch (error) {
        debug('origin.default.failed', { error: String(error) })
        return undefined
      }
    }

    /**
     * Where this app's PTY server is - asked over RPC, then looked up by project, then guessed,
     * and started only when the user asked for it. `origin.ts` owns the order and the reasons.
     */
    const originFinder = createOriginFinder({
      client: context.client,
      // The raw call: it throws on a host without RPC and rejects `not_running` when none
      // listens, and both of those mean "look somewhere else".
      ask: () => context.client.rpc(PtyServerRpc).origin({}),
      keys: () => projectKeys(context.location?.directory, defaultLocation()),
      onStartError: (error) => setPanel((draft) => noteStartError(draft, error)),
      debug,
    })

    const runRefresh = async (mayStart: boolean): Promise<void> => {
      if (mayStart && panel.startFailures >= MAX_START_FAILURES) {
        // Checked BEFORE the attempt, so "stopped retrying" means no further
        // create-session/delete-session cycles until the user clicks again.
        setPanel((draft) => {
          draft.status = statusWhenUnavailable(draft.startFailures, draft.lastStartError)
        })
        return
      }
      let origin = panel.origin
      if (origin !== null && !(await isHealthy(origin))) {
        // Force re-discovery: the server binds a fresh random port on every start,
        // so yesterday's address is a dead port.
        origin = null
      }
      if (origin === null) {
        origin = await originFinder.find(mayStart)
      }
      if (origin === null) {
        setPanel((draft) => noteNoServer(draft, mayStart))
        return
      }
      const sessions = await listSessions(origin)
      setPanel((draft) => noteListSuccess(draft, origin as string, sessions))
    }

    /**
     * Refresh the panel.
     *
     * `mayStart` marks a refresh the user asked for by expanding the panel; only
     * such a refresh may create a session in order to start the server. `force`
     * marks one they are waiting on, after a removal: a plain tick landing
     * mid-refresh can be dropped, because the in-flight one is already listing, but
     * a forced one cannot be or the row they just removed would linger until the
     * next tick.
     */
    const refresh = async (mayStart = false, force = false): Promise<void> => {
      if (disposed) return
      // A start takes seconds while the poll ticks every 2.5s, so without this a host
      // where the server never comes up would run several create-session/delete-session
      // cycles at once, forever.
      if (refreshing) {
        if (mayStart) startPending = true
        else if (force) relistPending = true
        return
      }
      refreshing = true
      try {
        await runRefresh(mayStart)
        await sessionPanelHost.sync()
      } catch (error) {
        setPanel((draft) => noteUnreachable(draft, error))
        debug('refresh.failed', { error: String(error) })
      } finally {
        refreshing = false
        if (startPending) {
          // A start re-lists too, so it supersedes a queued plain refresh.
          startPending = false
          relistPending = false
          void refresh(true)
        } else if (relistPending) {
          relistPending = false
          void refresh()
        }
      }
    }

    const actions = createActions({
      context,
      state: panel,
      update: setPanel,
      refresh,
      notify,
      // No start right: the actions act on a session that came from a list, so a server exists.
      findOrigin: () => originFinder.find(false),
      debug,
      tones,
    })

    const sessionPanelHost = createSessionPanelHost({
      context,
      panel,
      tones,
      debug,
      refresh,
      origin: () => panel.origin,
      // AFTER createActions, deliberately: the send control needs the action that opens the
      // prompt, and the action needs nothing from the host. The other way round this was a
      // reference to something not yet created.
      sendInput: actions.sendInput,
    })

    const onToggle = (): void => {
      const next = !prefs.collapsed
      setPrefs((draft) => {
        draft.collapsed = next
      })
      debug('header.toggle', { collapsed: next })
      // Expanding is the user asking to see the sessions, so it is the trigger for
      // starting the server - the only one. The resolved origin is cleared inside
      // refresh(), which re-resolves when it is null, and that is what makes the
      // click a real retry rather than a reuse of a dead address.
      if (!next) void refresh(true)
    }

    /**
     * Show or hide the failed finished rows.
     *
     * Deliberately does NOT refresh: the archive is already in the panel state, since
     * `/api/sessions` returns finished sessions too. Expanding is a view change, and
     * the only refresh allowed to start a server is one the user asked for by expanding
     * the panel itself - a second trigger here would start a server from a click on a
     * line that looks like a count.
     */
    const onToggleArchive = (): void => {
      const next = !prefs.showFinished
      setPrefs((draft) => {
        draft.showFinished = next
      })
      debug('archive.toggle', { showFinished: next })
    }

    /**
     * A click on a row opens the panel with THAT row on screen.
     *
     * The click used to open the output dialog, deferred by a tick because a dialog opened on
     * mouse-DOWN saw the trailing click land outside its brand-new modal and dismiss itself.
     * There is no modal here: the panel is a region that stays put, so the deferral goes with
     * it, and one gesture now gets a reader from the sidebar to the output.
     */
    const onOpen = (session: PanelSession): void => {
      sessionPanelHost.openWith(session)
    }

    /**
     * Fold one parent conversation's rows shut, or open them again.
     *
     * The transition itself is `sidebar-prefs`'s; this only wakes the store, which is what the
     * host needs to persist and re-render.
     */
    const onToggleGroup = (key: string): void => {
      setPrefs((draft) => toggleGroup(draft, key))
      debug('group.toggle', { key })
    }

    /**
     * Clear the filter, from the header's chip.
     *
     * The route that needs no typing, and the reason the chip exists: a reader who cannot see
     * the rows the query excluded should not have to retype anything to get them back. An empty
     * query is not a separate state - the shared matcher treats it as no query at all.
     */
    const onClearFilter = (): void => {
      if (prefs.filter === '') return
      setPrefs((draft) => setFilter(draft, ''))
      debug('filter.cleared')
    }

    /**
     * The parent conversations' titles, for the group headings.
     *
     * A synchronous lookup on the host rather than a request: the panel already holds a context,
     * and `data.session.get` answers from the list the TUI keeps. The loop itself is in `lib.ts`,
     * where it is pure and tested.
     */
    const parentTitles = (sessions: readonly PanelSession[]): Record<string, string> =>
      resolveParentTitles(sessions, (id) => context.data.session.get(id)?.title)

    registerFilterCommand(context, {
      current: () => prefs.filter,
      set: (query) => setPrefs((draft) => setFilter(draft, query)),
      debug,
    })

    const view = (): PanelView => {
      const titles = parentTitles(panel.sessions)
      const visible = visibleSessions(panel.sessions, prefs.showFinished)
      const groups = groupsForDisplay(visible, titles, prefs.filter)
      return {
        tones: tones(),
        collapsed: prefs.collapsed,
        // `origin !== null` is exactly "the last list landed" - the non-count statuses
        // (idle, starting, unreachable, a named cause) all clear it - so the count is
        // substituted only where `panel.status` IS a count.
        status:
          panel.origin === null
            ? panel.status
            : sessionCountForHeader(
                panel.sessions.length,
                // Counted over the groups the body draws, so the numerator and "nothing
                // matches" agree instead of contradicting each other.
                countSessions(groups),
                prefs.filter
              ),
        sessions: panel.sessions,
        groups,
        titles,
        filter: prefs.filter,
        collapsedGroups: prefs.collapsedGroups,
        showFinished: prefs.showFinished,
        onToggle,
        onToggleArchive,
        onToggleGroup,
        onClearFilter,
        onClear: actions.onClear,
        onOpen,
        onRemove: actions.confirmRemove,
      }
    }

    context.ui.slot({
      // Additive: the panel sits ALONGSIDE the built-in sidebar items rather than
      // replacing them. A replacement would take over a boundary every other item
      // lives in.
      append: 'sidebar.content',
      render: () => sidebarView(view()),
    })

    context.ui.slot({
      // The archive's size, in the one place that does not push the built-in items
      // down. Additive for the same reason as the panel itself.
      append: 'sidebar.footer',
      render: () => sidebarFooterView(view()),
    })

    sessionPanelHost.register()
    sessionPanelHost.registerClose()

    debug('setup')

    // Deliberately not awaited: the host awaits setup before the TUI is usable, so
    // setup must not wait on a refresh that can take seconds. The panel renders its
    // starting status and fills in when the answer arrives.
    void refresh()
    const poll = setInterval(() => void refresh(), POLL_MS)

    return (): void => {
      disposed = true
      clearInterval(poll)
      debug('dispose')
    }
  },
})
