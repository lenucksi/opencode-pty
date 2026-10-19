/**
 * The pure parts of `pty_read`: budgets, formatting and pattern validation.
 *
 * Split out of the tool so the tool stays a dispatcher over the three read shapes.
 * Nothing here talks to the manager - that is what makes it testable without a
 * session, and what keeps it out of the file the tool descriptions live in.
 */

import {
  charsForTokens,
  DEFAULT_READ_MAX_TOKENS,
  MAX_READ_MAX_TOKENS,
  READ_MAX_TOKENS_CEILING_ENV,
  READ_MAX_TOKENS_ENV,
  readTokenBudget,
} from '../../../shared/constants.ts'
import type { OutputBlockMeta } from '../formatters.ts'
import type { PTYSessionInfo } from '../types.ts'

const NOTIFY_ON_EXIT_REMINDER = [
  `<system_reminder>`,
  `This session was started with \`notifyOnExit=true\`.`,
  `Completion signal is the future \`<pty_exited>\` message, not repeated \`pty_read\` calls.`,
  `If you only need to know whether the command finished, stop polling and wait for \`<pty_exited>\`.`,
  `Do not use sleep plus \`pty_read\` loops to check completion.`,
  `Use \`pty_read\` only when you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.`,
  `If no \`<pty_exited>\` arrives (exit notifications are unavailable on some hosts), do not wait indefinitely: call \`pty_wait\` to block until the session exits.`,
  `</system_reminder>`,
].join('\n')

export function buildTimeoutReminder(session: PTYSessionInfo): string {
  return [
    `<system_reminder>`,
    `This session was auto-killed after reaching \`timeoutSeconds=${session.timeoutSeconds ?? 'unknown'}\`.`,
    `Use \`pty_read\` to inspect the final output or \`pty_list\` to review other sessions.`,
    `</system_reminder>`,
  ].join('\n')
}

export interface ReadArgs {
  id: string
  offset?: number
  limit?: number
  pattern?: string
  ignoreCase?: boolean
  maxTokens?: number
  all?: boolean
  since?: number
}

/** Highest token budget a caller may request, after env and the hard ceiling. */
function resolveCeiling(): number {
  return readTokenBudget(process.env, READ_MAX_TOKENS_CEILING_ENV, MAX_READ_MAX_TOKENS)
}

function resolveDefaultBudget(): number {
  return readTokenBudget(process.env, READ_MAX_TOKENS_ENV, DEFAULT_READ_MAX_TOKENS)
}

/**
 * Character budget for this call, or `undefined` when the caller asked for
 * everything.
 */
export function resolveBudget(args: ReadArgs): number | undefined {
  if (args.all === true) return undefined
  const ceiling = resolveCeiling()
  const requested = args.maxTokens ?? resolveDefaultBudget()
  return charsForTokens(Math.min(Math.max(1, requested), ceiling))
}

/**
 * Formats PTY output with XML tags and pagination
 */
export function formatPtyOutput(
  id: string,
  status: string,
  pattern: string | undefined,
  formattedLines: string[],
  hasMore: boolean,
  paginationMessage: string,
  endMessage: string,
  meta: OutputBlockMeta = {}
): string {
  const attrs: string[] = [`id="${id}"`, `status="${status}"`]
  if (pattern) attrs.push(`pattern="${pattern}"`)
  if (meta.truncatedLines) {
    attrs.push(`truncated="true"`, `truncatedLines="${meta.truncatedLines}"`)
  }
  if (meta.nextSince !== undefined && meta.nextSince !== null) {
    attrs.push(`nextSince="${meta.nextSince}"`)
  }
  if (meta.chars) attrs.push(`chars="${meta.chars.shown}/${meta.chars.total}"`)
  if (meta.all) attrs.push('all="true"')

  const notes: string[] = []
  if (meta.all) {
    notes.push(
      '(You asked for the complete buffer. This is unbounded and can overflow your context; prefer a bounded read unless you truly need everything.)'
    )
  }

  return [
    `<pty_output ${attrs.join(' ')}>`,
    ...formattedLines,
    '',
    hasMore ? paginationMessage : endMessage,
    ...notes,
    `</pty_output>`,
  ].join('\n')
}

function appendNotifyOnExitReminder(output: string, session: PTYSessionInfo): string {
  if (!session.notifyOnExit || session.status !== 'running') {
    return output
  }

  return `${output}\n\n${NOTIFY_ON_EXIT_REMINDER}`
}

function appendTimeoutReminder(output: string, session: PTYSessionInfo): string {
  if (!session.timedOut) {
    return output
  }

  return `${output}\n\n${buildTimeoutReminder(session)}`
}

export function appendSessionReminders(output: string, session: PTYSessionInfo): string {
  return appendTimeoutReminder(appendNotifyOnExitReminder(output, session), session)
}

/**
 * Validates and creates a RegExp from pattern string
 */
export function validateAndCreateRegex(pattern: string, ignoreCase?: boolean): RegExp {
  if (!validateRegex(pattern)) {
    throw new Error(
      `Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.`
    )
  }

  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid regex pattern '${pattern}': ${error}`)
  }
}

/**
 * Rejects regexes that look like catastrophic backtracking.
 */
export function validateRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    // Check for potentially dangerous patterns that can cause exponential backtracking
    // This is a basic check - more sophisticated validation could be added
    const dangerousPatterns = [
      /\(\?:.*\)\*.*\(\?:.*\)\*/, // nested optional groups with repetition
      /.*\(\.\*\?\)\{2,\}.*/, // overlapping non-greedy quantifiers
      /.*\(.*\|.*\)\{3,\}.*/, // complex alternation with repetition
    ]
    return !dangerousPatterns.some((dangerous) => dangerous.test(pattern))
  } catch {
    return false
  }
}
