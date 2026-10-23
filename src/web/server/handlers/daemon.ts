/**
 * Rolling the daemon from the web interface.
 *
 * The daemon is machine state that every opencode instance on the machine shares:
 * one socket path, one pid file, one process that owns every PTY. Rolling it is
 * therefore a decision about the machine and not about the page that asks - which
 * is why the work happens in the manager and this handler only reports it.
 *
 * It ends every session the daemon owns. That is the point of a restart: the PTY
 * masters belong to that process, and a new daemon starts with an empty archive
 * and the sessions the old one flushed to disk.
 *
 * The roll is announced like any other (`notifyUser`), with the page's own action id
 * as the origin: the page that clicked already shows the answer next to the button,
 * and the other surfaces - the TUI's sidebar - have no way of knowing the machine
 * changed. The page recognises its own id and stays quiet.
 */

import { restartDaemon } from '../../../plugin/pty/manager.ts'
import { logPtyEvent } from '../../../plugin/pty/plugin-log.ts'
import { originFrom } from '../../../shared/notice.ts'
import { notifyUser } from '../../../v2/rpc.ts'
import { ErrorResponse, JsonResponse } from './responses.ts'

/**
 * The action id from the request body, if it sent one.
 *
 * A body is optional here: the click works without one, and a page that does not
 * send an id simply sees its own roll announced like any other. The API client
 * always sends one, which is what keeps the answer from being reported twice.
 */
async function actionIdOf(request: Request): Promise<string | undefined> {
  try {
    return originFrom(await request.json())
  } catch {
    // No body, or not JSON: no id, which is a valid way to ask.
    return undefined
  }
}

export async function restartDaemonRoute(request: Request): Promise<Response> {
  const actionId = await actionIdOf(request)
  try {
    const { oldPid, newPid } = await restartDaemon()
    const restarted = oldPid !== null || newPid !== null
    logPtyEvent('info', 'the daemon was restarted from the web interface', { oldPid, newPid })
    notifyUser(
      restarted
        ? `PTY daemon restarted: old pid ${oldPid ?? 'none'}, new pid ${newPid ?? 'none'}.`
        : 'There is no PTY daemon to restart.',
      restarted ? 'success' : 'warning',
      actionId
    )
    return new JsonResponse({
      oldPid: oldPid ?? 0,
      newPid: newPid ?? 0,
      restarted,
    })
  } catch (error) {
    logPtyEvent('error', 'the daemon could not be restarted', error)
    return new ErrorResponse(
      error instanceof Error ? error.message : 'The PTY daemon could not be restarted',
      500
    )
  }
}
