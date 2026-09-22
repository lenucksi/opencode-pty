import { manager } from './manager.ts'

/**
 * Readable reason for a failure, so a tool result can say why something broke
 * instead of leaving the model to guess (an opaque "spawn failed" once made a
 * model invent a session limit that never existed).
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name
  return String(error)
}

/**
 * Error for an unknown session id.
 *
 * A session that lives on in the archive is reported as `<pty_session_lost>`:
 * after a restart the model usually still believes it is running, and the tail
 * of its output is exactly what it needs to continue sensibly.
 */
export function buildSessionNotFoundError(id: string): Error {
  const archived = manager.describeMissingSession(id)
  if (!archived) {
    return new Error(`PTY session '${id}' not found. Use pty_list to see active sessions.`)
  }

  const lines = [
    '<pty_session_lost>',
    `ID: ${archived.id}`,
    `Status: ${archived.status}${archived.lost ? ' (lost in a PTY server restart)' : ''}`,
    `Generation: ${archived.generation}`,
    `Output Lines: ${archived.lineCount}`,
  ]

  if (archived.tail) {
    lines.push('Tail:')
    for (const line of archived.tail.split('\n')) {
      lines.push(`  ${line}`)
    }
  }

  lines.push(
    'The process is gone, but this transcript is archived on disk.',
    `Read more of it with: pty_read({ id: '${archived.id}' }) or GET /api/sessions/${archived.id}/log`,
    'Start it again if you still need it.',
    '</pty_session_lost>'
  )

  return new Error(lines.join('\n'))
}

/**
 * Helper to DRY up session-get/null-check logic
 * - manager: object with a getSession(id) or similar method
 * - id: session id
 * - fn: function called with session if found
 * - defaultValue: what to return if not found (default null)
 */
export function withSession<TSession, TResult>(
  manager: { getSession(id: string): TSession | null },
  id: string,
  fn: (session: TSession) => TResult,
  defaultValue: TResult
): TResult {
  const session = manager.getSession(id)
  if (!session) return defaultValue
  return fn(session)
}
