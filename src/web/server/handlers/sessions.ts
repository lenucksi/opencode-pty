import { logFileName, normalizeLogText, parseLogFormat } from '../../shared/log-format.ts'
import { WEB_API_PARENT_SESSION_ID } from '../../../plugin/constants.ts'
import { manager } from '../../../plugin/pty/manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../../../plugin/pty/permissions.ts'
import type { BunRequest } from 'bun'
import { JsonResponse, ErrorResponse } from './responses.ts'
import type { routes } from '../../shared/routes.ts'

export function getSessions() {
  const sessions = manager.list()
  return new JsonResponse(sessions)
}

export async function createSession(req: Request) {
  let body: {
    command: string
    args?: string[]
    description?: string
    workdir?: string
    timeoutSeconds?: number
  }

  try {
    body = (await req.json()) as typeof body
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }

  if (!body.command || typeof body.command !== 'string' || body.command.trim() === '') {
    return new ErrorResponse('Command is required', 400)
  }

  try {
    const args = body.args || []
    await checkCommandPermission(body.command, args)
    if (body.workdir) {
      await checkWorkdirPermission(body.workdir)
    }

    const session = manager.spawn({
      command: body.command,
      args,
      title: body.description,
      description: body.description,
      workdir: body.workdir,
      timeoutSeconds: body.timeoutSeconds,
      parentSessionId: WEB_API_PARENT_SESSION_ID,
    })
    return new JsonResponse(session)
  } catch (error) {
    return new ErrorResponse(
      error instanceof Error ? error.message : 'Failed to create session',
      400
    )
  }
}

export function clearSessions() {
  manager.clearAllSessions()
  return new JsonResponse({ success: true })
}

/**
 * Read the `ids` array out of a removal or restore request.
 *
 * Answers null instead of throwing so each handler can phrase its own error, and
 * filters nothing silently: an entry that is not a non-empty string fails the
 * whole request rather than quietly shrinking the removal to the ids that
 * happened to parse, because a request for 12 sessions that removes 11 is worse
 * than one that removes none.
 */
async function readIds(req: Request): Promise<string[] | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || !('ids' in body)) return null
  const { ids } = body
  if (!Array.isArray(ids)) return null

  const parsed: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') return null
    parsed.push(id)
  }
  return parsed
}

export async function bulkRemoveSessions(
  req: BunRequest<typeof routes.sessions.bulk.path>
): Promise<Response> {
  const ids = await readIds(req)
  if (ids === null) {
    return new ErrorResponse('Expected a body with an array of session ids', 400)
  }
  if (ids.length === 0) {
    // A removal of nothing is a client bug, and answering 200 would hide it.
    return new ErrorResponse('No session ids given', 400)
  }
  return new JsonResponse(manager.bulkRemove(ids))
}

export async function restoreSessions(
  req: BunRequest<typeof routes.sessions.restore.path>
): Promise<Response> {
  const ids = await readIds(req)
  if (ids === null) {
    return new ErrorResponse('Expected a body with an array of session ids', 400)
  }
  if (ids.length === 0) {
    return new ErrorResponse('No session ids given', 400)
  }
  return new JsonResponse(manager.restoreSessions(ids))
}

export function getSession(req: BunRequest<typeof routes.session.path>) {
  const session = manager.get(req.params.id)
  if (!session) {
    return new ErrorResponse('Session not found', 404)
  }
  return new JsonResponse(session)
}

export async function sendInput(
  req: BunRequest<typeof routes.session.input.path>
): Promise<Response> {
  try {
    const body = (await req.json()) as { data: string }
    if (!body.data || typeof body.data !== 'string') {
      return new ErrorResponse('Data field is required and must be a string', 400)
    }
    const success = manager.write(req.params.id, body.data)
    if (!success) {
      return new ErrorResponse('Failed to write to session', 400)
    }
    return new JsonResponse({ success: true })
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }
}

export function cleanupSession(req: BunRequest<typeof routes.session.cleanup.path>) {
  const success = manager.kill(req.params.id, true)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function killSession(req: BunRequest<typeof routes.session.path>) {
  const success = manager.kill(req.params.id)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function getRawBuffer(req: BunRequest<typeof routes.session.buffer.raw.path>) {
  const sinceParam = new URL(req.url).searchParams.get('since')
  const since = sinceParam !== null && sinceParam.trim() !== '' ? Number(sinceParam) : undefined
  const bufferData = manager.getRawBuffer(
    req.params.id,
    since !== undefined && Number.isFinite(since) ? since : undefined
  )
  if (!bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  return new JsonResponse(bufferData)
}

/**
 * The archived transcript of a session as plain text, with an optional tail.
 * Works for live sessions too, so a caller has one place to fetch output from
 * (useful after a restart, when only the archive is left).
 */
export function getSessionLog(req: BunRequest<typeof routes.session.log.path>) {
  const url = new URL(req.url)
  const tailParam = url.searchParams.get('tail')
  const parsedTail = tailParam === null ? undefined : Number.parseInt(tailParam, 10)
  const tail =
    parsedTail !== undefined && Number.isSafeInteger(parsedTail) && parsedTail > 0
      ? parsedTail
      : undefined
  const format = parseLogFormat(url.searchParams.get('format'))

  const raw = manager.getSessionLog(req.params.id, tail === undefined ? {} : { tail })
  if (raw === null) {
    return new ErrorResponse('Session not found', 404)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (url.searchParams.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${logFileName(req.params.id, format)}"`
  }
  return new Response(normalizeLogText(raw, format), { headers })
}

export function getPlainBuffer(req: BunRequest<typeof routes.session.buffer.plain.path>) {
  const bufferData = manager.getRawBuffer(req.params.id)
  if (!bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  const plainText = Bun.stripANSI(bufferData.raw)
  return new JsonResponse({
    plain: plainText,
    byteLength: new TextEncoder().encode(plainText).length,
  })
}
