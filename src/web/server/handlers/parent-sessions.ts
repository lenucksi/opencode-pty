import { WEB_API_PARENT_SESSION_ID } from '../../../plugin/constants.ts'
import { manager } from '../../../plugin/pty/manager.ts'
import { resolveParentSessionTitles } from '../../../plugin/pty/parent-session-title.ts'
import type { ParentSessionTitlesResponse } from '../../shared/types.ts'
import { JsonResponse } from './responses.ts'

/** Readable labels for the OpenCode sessions that own the current PTY list. */
export async function getParentSessions(): Promise<Response> {
  const sessionIDs = manager
    .list()
    .map((session) => session.parentSessionId)
    .filter(
      (id): id is string => typeof id === 'string' && id !== '' && id !== WEB_API_PARENT_SESSION_ID
    )

  const response: ParentSessionTitlesResponse = {
    titles: await resolveParentSessionTitles(sessionIDs),
  }
  return new JsonResponse(response)
}
