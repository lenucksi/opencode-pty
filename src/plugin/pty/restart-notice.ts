import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PtyLogger } from './plugin-log.ts'

export interface RestartNoticeSession {
  id: string
  title: string
  status: string
  lineCount: number
  /** Last non-empty lines, already plain text. */
  tail: string
}

export interface RestartNoticeInput {
  generation: string
  startedAt: string
  /** Where a human can look at the sessions. */
  webUrl?: string
  hostVersion?: string
  lost: RestartNoticeSession[]
  archivedCount: number
  persistEnabled: boolean
  retention?: { maxAgeDays: number; maxSessions: number }
}

/**
 * The message a session receives when the PTY server came back and left
 * sessions behind.
 *
 * Written for a model that still believes those sessions are running: it says
 * what happened, what survived on disk, and how to continue.
 */
export function buildRestartNotice(input: RestartNoticeInput): string {
  const lines = [
    '<pty_restart>',
    `Generation: ${input.generation}`,
    `Started: ${input.startedAt}`,
    ...(input.hostVersion ? [`Host: opencode ${input.hostVersion}`] : []),
    ...(input.webUrl ? [`Web UI: ${input.webUrl}`] : []),
    `Sessions before restart: ${input.lost.length} lost, ${input.archivedCount} archived`,
  ]

  for (const session of input.lost) {
    lines.push(
      `  - ${session.id}  ${session.title}  (${session.status}, ${session.lineCount} lines)`
    )
    if (session.tail) {
      lines.push(`    tail: ${session.tail.replaceAll('\n', ' | ')}`)
    }
  }

  lines.push(
    input.persistEnabled
      ? `Storage: archived on disk${
          input.retention
            ? ` (keep ${input.retention.maxAgeDays} days / ${input.retention.maxSessions} sessions)`
            : ''
        }`
      : 'Storage: archiving is disabled, lost output is gone',
    'Archived transcripts: GET /api/sessions/<id>/log, or pty_read with the archived id.',
    'Anything that was running has to be started again if you still need it.',
    'Completion of running sessions is reported with pty_wait; if the pty_* tools are missing in this turn, retry next turn or use the HTTP API.',
    '</pty_restart>',
    ''
  )

  return lines.join('\n')
}

/** Marker file remembering which boot already announced itself. */
export function announcedGenerationPath(root: string): string {
  return join(root, 'announced-generation')
}

export function readAnnouncedGeneration(root: string): string | null {
  try {
    const path = announcedGenerationPath(root)
    if (!existsSync(path)) return null
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export function writeAnnouncedGeneration(root: string, generation: string, log: PtyLogger): void {
  try {
    writeFileSync(announcedGenerationPath(root), `${generation}\n`, { mode: 0o600 })
  } catch (error) {
    log('warn', 'could not record the announced generation', error)
  }
}
