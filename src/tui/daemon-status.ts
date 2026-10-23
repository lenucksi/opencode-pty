import type { Plugin } from '@opencode/plugin/tui'

import type { PanelSession } from './lib.ts'
import { daemonStatusFromData, PtyServerRpc } from '../v2/rpc.ts'

/**
 * The session list and the daemon's pid, asked in the same tick.
 *
 * The footer's line shows the pid of the daemon that is running, so a roll started
 * anywhere - another instance, the browser - has to reach it. A second round trip
 * per poll would be a second reason for the line to lag behind the rows, so both go
 * out together.
 *
 * The status is allowed to fail on its own: a host whose half predates the method
 * answers nothing, and a line without a pid is still a working line. A list that
 * fails is the caller's problem, so that error is not caught here.
 */
export interface DaemonPollDeps {
  /** The host's client, for the plugin's own RPC. */
  readonly client: Plugin.Context['client']
  /** The rows, as the server reported them. */
  readonly listSessions: () => Promise<readonly PanelSession[]>
  /** The panel's own trace, for a status that could not be read. */
  readonly debug: (event: string, detail?: unknown) => void
}

export async function listWithDaemonPid(
  deps: DaemonPollDeps
): Promise<{ sessions: readonly PanelSession[]; pid: number | null }> {
  const [sessions, pid] = await Promise.all([
    deps.listSessions(),
    askDaemonPid(deps.client).catch((error: unknown) => {
      deps.debug('daemon.status.failed', { error: String(error) })
      return null
    }),
  ])
  return { sessions, pid }
}

async function askDaemonPid(client: Plugin.Context['client']): Promise<number | null> {
  return daemonStatusFromData(await client.rpc(PtyServerRpc).daemonStatus({}))
}
