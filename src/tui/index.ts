import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin/tui'

import { createActions } from './actions.ts'
import type { PanelSession } from './lib.ts'
import {
  initialPanelState,
  MAX_START_FAILURES,
  noteListSuccess,
  noteNoServer,
  noteStartError,
  noteUnreachable,
  statusWhenUnavailable,
  type PanelState,
} from './panel-state.ts'
import { sidebarView, type PanelView } from './render.ts'
import { findProjectOrigin, isHealthy, listSessions } from './server.ts'
import { runtimeDir } from '../shared/runtime.ts'

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
 * The host loads a TUI plugin with a plain `import()`, so the plugin resolves
 * `solid-js` itself - and under Bun that goes through the `node` export condition
 * to `dist/server.js`, where reactivity is a no-op: `createSignal` returns an inert
 * pair. The reconciler inside `@opentui/solid` imports the client build directly,
 * so its accessor machinery is live while anything the plugin creates itself is
 * not. A plugin-local signal would therefore render once and never again, and the
 * failure is invisible because the first frame is correct.
 *
 * `context.storage` is the one reactive substrate available: the host creates it,
 * with its own solid instance, and opencode's own slot plugins read it the same
 * way. So every mutable thing the panel shows is in there.
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
const BOOTSTRAP_TITLE = 'opencode-pty sidebar bootstrap'
const BOOTSTRAP_ATTEMPTS = 20
const BOOTSTRAP_INTERVAL_MS = 300

/** Durable: the collapsed state is a user preference, like the built-in items'. */
const PREFS_KEY = 'opencode-pty.sidebar'

/**
 * Ephemeral: the list is this process's view of a server that can restart on a new
 * port, and a persisted copy would come back stale on the next start - which looks
 * like a bug rather than a remembered snapshot. It does survive a hot reload, which
 * is the case that actually bites.
 */
const PANEL_KEY = 'opencode-pty.sidebar.panel'

/**
 * A TUI plugin has no console, and its wiring cannot be driven headlessly by the
 * test suite, so a small event log is the only way to diagnose interaction
 * problems. Off by default: it appends unboundedly, and a plugin that quietly grows
 * a file forever is not acceptable. `PTY_TUI_DEBUG=1` turns it on.
 */
const DEBUG_ENV = 'PTY_TUI_DEBUG'

function debugEnabled(): boolean {
  const value = process.env[DEBUG_ENV]
  return typeof value === 'string' && value !== '' && value !== '0'
}

function debug(event: string, detail?: unknown): void {
  if (!debugEnabled()) return
  try {
    // The runtime dir, so this lands beside the origin records: per-user and
    // already 0700, rather than a world-readable path in /tmp.
    const dir = runtimeDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
    appendFileSync(join(dir, 'tui-debug.log'), `${new Date().toISOString()} ${event}${suffix}\n`, {
      mode: 0o600,
    })
  } catch (_) {
    /* logging must never break the panel */
  }
}

export default Plugin.define({
  id: 'opencode-pty',
  setup(context: Plugin.Context) {
    const [panel, setPanel] = context.storage.memory<PanelState>(PANEL_KEY, {
      initial: initialPanelState(),
    })
    const [prefs, setPrefs] = context.storage.store(PREFS_KEY, { initial: { collapsed: true } })

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

    const directory = (): string | undefined => context.location?.directory

    /**
     * Start the server by running this plugin's own command in a throwaway session,
     * then read the origin it published.
     *
     * The session is scratch space: the command posts the URL as a chat message,
     * and a permanent "sidebar bootstrap" row in the user's session list would be
     * worse than the transcript noise it avoids.
     */
    const startServer = async (): Promise<string | null> => {
      let sessionID: string | null = null
      let failure: unknown = null
      try {
        sessionID = (await context.client.session.create({ title: BOOTSTRAP_TITLE })).id
        await context.client.session.command({ sessionID, name: 'pty-show-server-url', text: '' })
      } catch (error) {
        failure = error
      }
      if (sessionID !== null) {
        await context.client.session.remove({ sessionID }).catch((error: unknown) => {
          debug('start.cleanup.failed', { sessionID, error: String(error) })
        })
      }
      if (failure !== null) {
        setPanel((draft) => noteStartError(draft, failure))
        return null
      }
      // The server publishes its record after binding, so this is a poll rather than
      // a single check. Bounded: a server that never comes up must not spin.
      for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
        await Bun.sleep(BOOTSTRAP_INTERVAL_MS)
        const origin = await findProjectOrigin(directory())
        if (origin !== null) {
          debug('start.done', { origin, attempt })
          return origin
        }
      }
      return null
    }

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
        origin = (await findProjectOrigin(directory())) ?? (mayStart ? await startServer() : null)
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
      directory,
      debug,
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

    const onOpen = (session: PanelSession): void => {
      // Mouse UP, deferred one tick. Opening on DOWN meant the dialog's
      // click-outside dismissal saw the trailing click land outside the brand-new
      // modal and closed it within the same gesture.
      setTimeout(() => {
        void actions.openOutput(session).catch((error: unknown) => {
          // A click that silently does nothing is indistinguishable from a broken
          // panel, so say so out loud rather than only to the log.
          debug('row.open.failed', { id: session.id, error: String(error) })
          notify(`Could not open ${session.title || session.id}: ${String(error)}`, 'error')
        })
      }, 0)
    }

    const view = (): PanelView => ({
      tones: {
        base: context.theme.text.base,
        muted: context.theme.text.muted,
        success: context.theme.text.feedback.success.base,
        error: context.theme.text.feedback.error.base,
        border: context.theme.border.base,
        raised: context.theme.background.raised.base,
      },
      collapsed: prefs.collapsed,
      status: panel.status,
      sessions: panel.sessions,
      onToggle,
      onClear: actions.onClear,
      onOpen,
      onRemove: actions.confirmRemove,
    })

    context.ui.slot({
      // Additive: the panel sits ALONGSIDE the built-in sidebar items rather than
      // replacing them. A replacement would take over a boundary every other item
      // lives in.
      append: 'sidebar.content',
      render: () => sidebarView(view()),
    })

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
