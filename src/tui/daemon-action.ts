import type { MouseEvent } from '@opentui/core'

import type { Plugin } from '@opencode/plugin/tui'

import { daemonRestartFromData, PtyServerRpc } from '../v2/rpc.ts'
import { type DaemonHolder, noteDaemonRestarted, noteDaemonRestarting } from './daemon-state.ts'

/**
 * Rolling the daemon, from the sidebar's footer.
 *
 * The daemon is machine state that every opencode instance shares, so the roll
 * is asked of the half that owns the client - the server half, over the plugin's
 * own RPC. The TUI cannot do it itself: it is a different process, and the
 * daemon belongs to the server.
 *
 * The line says "restarting..." while it runs, and the toast says what happened:
 * a roll that ends with a different pid, or one that found nothing to roll.
 */

/** What the action needs from the panel's wiring. */
export interface DaemonRollDeps {
  /** The host's client, for the plugin's own RPC. */
  readonly client: Plugin.Context['client']
  /**
   * The panel's state, through the store.
   *
   * A mutator rather than the state itself: the line is drawn from the store, so
   * a change that does not go through it would not reach the screen.
   */
  readonly update: (mutate: (draft: DaemonHolder) => void) => void
  /** Say what happened, where the reader will see it. */
  readonly notify: (message: string, variant: 'info' | 'success' | 'warning' | 'error') => void
  /** The panel's own trace, for a reader who wants to see what was asked. */
  readonly debug: (event: string, detail?: unknown) => void
}

/**
 * The click handler for the footer's daemon line.
 *
 * Returns the handler rather than doing the work, so the wiring decides when it
 * is created and the action itself stays testable on its own.
 */
export function restartDaemonAction(deps: DaemonRollDeps): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    event.stopPropagation()
    deps.update((draft) => noteDaemonRestarting(draft))
    deps.debug('daemon.restart.requested')
    void deps.client
      .rpc(PtyServerRpc)
      .restartDaemon({})
      .then((raw: unknown) => {
        const answer = daemonRestartFromData(raw)
        deps.update((draft) => noteDaemonRestarted(draft, answer?.newPid ?? null))
        if (answer === null) {
          deps.notify('The daemon did not answer the restart.', 'warning')
          return
        }
        deps.notify(
          answer.restarted
            ? `PTY daemon restarted: old pid ${answer.oldPid ?? 'none'}, new pid ${answer.newPid ?? 'none'}.`
            : 'There is no PTY daemon to restart.',
          answer.restarted ? 'success' : 'warning'
        )
      })
      .catch((error: unknown) => {
        deps.update((draft) => noteDaemonRestarted(draft, null))
        deps.notify(
          `The PTY daemon could not be restarted: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      })
  }
}
