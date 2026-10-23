import type { Plugin } from '@opencode/plugin/tui'

import { OriginClaim } from '../shared/notice.ts'
import { noticeFromData, PtyServerRpc } from '../v2/rpc.ts'

/**
 * What the server half says, and which of it this surface caused itself.
 *
 * The host executes a slash command and drops whatever it returned, so a command
 * that worked and a command that did nothing look the same. The server half says
 * what it did over the plugin's own RPC event, and this is where that becomes a
 * toast in front of the reader.
 *
 * The returned claim is shared with the roll in `daemon-action.ts`: a roll this
 * surface started is announced like any other, and the sidebar shows the answer to
 * its own roll already - so it has to recognise its own notice and stay quiet. One
 * claim for both, because two would be two different answers to "is this ours?".
 */
export interface NoticeDeps {
  /** The host's client, for the plugin's own RPC. */
  readonly client: Plugin.Context['client']
  /** Say what happened, where the reader will see it. */
  readonly notify: (message: string, variant: 'info' | 'success' | 'warning' | 'error') => void
  /** The panel's own trace, for a reader who wants to see what was subscribed. */
  readonly debug: (event: string, detail?: unknown) => void
}

export function subscribeNotices(deps: NoticeDeps): OriginClaim {
  const claim = new OriginClaim()
  try {
    deps.client.rpc(PtyServerRpc).events.on('notice', (event) => {
      const notice = noticeFromData(event.data)
      if (!notice) return
      // Our own roll: the answer is on screen already.
      if (claim.owns(notice.origin)) return
      deps.notify(notice.message, notice.variant)
    })
  } catch (error) {
    deps.debug('notice.subscribe.failed', { error: String(error) })
  }
  return claim
}
