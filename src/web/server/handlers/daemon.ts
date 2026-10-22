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
 */

import { restartDaemon } from '../../../plugin/pty/manager.ts'
import { logPtyEvent } from '../../../plugin/pty/plugin-log.ts'
import { ErrorResponse, JsonResponse } from './responses.ts'

export async function restartDaemonRoute(): Promise<Response> {
  try {
    const { oldPid, newPid } = await restartDaemon()
    logPtyEvent('info', 'the daemon was restarted from the web interface', { oldPid, newPid })
    return new JsonResponse({
      oldPid: oldPid ?? 0,
      newPid: newPid ?? 0,
      restarted: oldPid !== null || newPid !== null,
    })
  } catch (error) {
    logPtyEvent('error', 'the daemon could not be restarted', error)
    return new ErrorResponse(
      error instanceof Error ? error.message : 'The PTY daemon could not be restarted',
      500
    )
  }
}
