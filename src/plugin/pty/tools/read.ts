import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import {
  charsForTokens,
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_TOKENS,
  MAX_READ_MAX_TOKENS,
  READ_MAX_TOKENS_CEILING_ENV,
  READ_MAX_TOKENS_ENV,
  readTokenBudget,
} from '../../../shared/constants.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import {
  formatLine,
  formatPtyOutputBlock,
  TRUNCATION_MARKER,
  type OutputBlockMeta,
} from '../formatters.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './read.txt'

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

function buildTimeoutReminder(session: PTYSessionInfo): string {
  return [
    `<system_reminder>`,
    `This session was auto-killed after reaching \`timeoutSeconds=${session.timeoutSeconds ?? 'unknown'}\`.`,
    `Use \`pty_read\` to inspect the final output or \`pty_list\` to review other sessions.`,
    `</system_reminder>`,
  ].join('\n')
}

interface ReadArgs {
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
function resolveBudget(args: ReadArgs): number | undefined {
  if (args.all === true) return undefined
  const ceiling = resolveCeiling()
  const requested = args.maxTokens ?? resolveDefaultBudget()
  return charsForTokens(Math.min(Math.max(1, requested), ceiling))
}

/**
 * Formats PTY output with XML tags and pagination
 */
function formatPtyOutput(
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

function appendSessionReminders(output: string, session: PTYSessionInfo): string {
  return appendTimeoutReminder(appendNotifyOnExitReminder(output, session), session)
}

/**
 * Validates and creates a RegExp from pattern string
 */
function validateAndCreateRegex(pattern: string, ignoreCase?: boolean): RegExp {
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
 * Handles pattern-based reading and formatting
 */
function handlePatternRead(
  args: ReadArgs,
  id: string,
  pattern: string,
  ignoreCase: boolean | undefined,
  session: PTYSessionInfo,
  offset: number,
  limit: number,
  budget: number | undefined
): string {
  const regex = validateAndCreateRegex(pattern, ignoreCase)

  const result = manager.search(id, regex, offset, limit, budget)
  if (!result) {
    throw buildSessionNotFoundError(id)
  }

  if (result.matches.length === 0) {
    return appendSessionReminders(
      formatPtyOutputBlock(
        id,
        session.status,
        [
          `No lines matched the pattern '${pattern}'.`,
          `Total lines in buffer: ${result.totalLines}`,
        ],
        { pattern }
      ),
      session
    )
  }

  // A match can be cut by the budget; mark it rather than dropping it silently.
  const lines = result.matches.map((match) => {
    const formatted = formatLine(match.text, match.lineNumber, match.text.length)
    return formatted.truncated
      ? `${formatted.text}${TRUNCATION_MARKER(formatted.shownChars, formatted.totalChars)}`
      : formatted.text
  })

  const endMessage = `(${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} from ${result.totalLines} total lines)`
  const paginationMessage = `(${lines.length} of ${result.totalMatches} matches shown. Use offset=${offset + lines.length} to see more.)`

  return appendSessionReminders(
    formatPtyOutput(
      id,
      session.status,
      pattern,
      lines,
      result.hasMore,
      paginationMessage,
      endMessage,
      { all: args.all === true, truncatedLines: result.truncatedLines }
    ),
    session
  )
}

/**
 * Handles plain reading and formatting
 */
function handlePlainRead(
  args: ReadArgs,
  session: PTYSessionInfo,
  offset: number,
  limit: number,
  budget: number | undefined
): string {
  const result = manager.read(args.id, offset, limit, budget)
  if (!result) {
    throw buildSessionNotFoundError(args.id)
  }

  if (result.lines.length === 0) {
    return appendSessionReminders(
      formatPtyOutputBlock(args.id, session.status, [
        `(No output available - buffer is empty)`,
        `Total lines: ${result.totalLines}`,
      ]),
      session
    )
  }

  // The budget is shared across the whole result, so a line may be cut. Each cut
  // is marked with an explicit, searchable token instead of a bare `...`, which
  // is indistinguishable from three literal dots in program output.
  const formattedLines: string[] = []
  let truncatedLines = 0
  for (const [index, slice] of result.slices.entries()) {
    const formatted = formatLine(slice.text, result.offset + index + 1, slice.shownChars)
    if (slice.truncated) truncatedLines += 1
    formattedLines.push(
      slice.truncated
        ? `${formatted.text}${TRUNCATION_MARKER(slice.shownChars, slice.totalChars)}`
        : formatted.text
    )
  }

  const nextLineOffset = result.offset + result.lines.length
  const paginationMessage = `(Buffer has more. Use offset=${nextLineOffset} to read beyond line ${nextLineOffset}, or since=${result.nextSince} to continue exactly where this result stopped.)`
  // Never claim the end of the buffer while a line is still cut: that is the lie
  // that made a frozen TUI look like a stable screen.
  const endMessage = truncatedLines
    ? `(Cut mid-result - ${result.shownChars} of ${result.bufferChars} chars shown. Continue with since=${result.nextSince}.)`
    : `(End of buffer - ${result.totalLines} lines, ${result.bufferChars} chars)`

  return appendSessionReminders(
    formatPtyOutput(
      args.id,
      session.status,
      undefined,
      formattedLines,
      result.hasMore,
      paginationMessage,
      endMessage,
      {
        all: args.all === true,
        truncatedLines,
        nextSince: result.nextSince,
        chars: { shown: result.shownChars, total: result.bufferChars },
      }
    ),
    session
  )
}

/**
 * Resume the raw character stream at an absolute offset.
 *
 * Line-based paging cannot recover a line that the budget cut in half: there is
 * no line offset inside a cut line to ask for. This path exists so that a caller
 * can walk the stream character by character and end up with exactly the bytes
 * the process produced, including the tail of a line an earlier call cut.
 */
function handleSinceRead(
  args: ReadArgs,
  session: PTYSessionInfo,
  budget: number | undefined
): string {
  const since = Math.max(0, Math.floor(args.since ?? 0))
  const result = manager.readSince(args.id, since, budget)
  if (!result) {
    throw buildSessionNotFoundError(args.id)
  }

  if (result.totalChars === 0) {
    return appendSessionReminders(
      formatPtyOutputBlock(args.id, session.status, [
        `(Nothing available at or after character ${since}.)`,
      ]),
      session
    )
  }

  const attrs = [
    `id="${args.id}"`,
    `status="${session.status}"`,
    `since="${result.since}"`,
    `chars="${result.shownChars}/${result.totalChars}"`,
  ]
  if (result.truncated) attrs.push('truncated="true"')
  if (result.nextSince !== null) attrs.push(`nextSince="${result.nextSince}"`)
  if (args.all === true) attrs.push('all="true"')

  const footer = result.nextSince
    ? `(Part of the stream. Continue with since=${result.nextSince}; ${result.shownChars} of ${result.totalChars} chars shown so far.)`
    : `(End of stream - ${result.totalChars} chars from offset ${result.since}.)`

  return appendSessionReminders(
    [
      `<pty_output ${attrs.join(' ')}>`,
      result.text,
      '',
      footer,
      ...(args.all === true
        ? [
            '(You asked for an unbounded read. This can overflow your context; prefer a bounded read with since-paging unless you truly need everything.)',
          ]
        : []),
      '</pty_output>',
    ].join('\n'),
    session
  )
}

/**
 * Rejects regexes that look like catastrophic backtracking.
 */
function validateRegex(pattern: string): boolean {
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

export const ptyRead = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    offset: tool.schema
      .number()
      .optional()
      .describe(
        'Line number to start reading from (0-based, defaults to 0). When using pattern, this applies to filtered matches.'
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe(
        'Number of lines to read (defaults to 500). When using pattern, this applies to filtered matches.'
      ),
    pattern: tool.schema
      .string()
      .optional()
      .describe(
        'Regex pattern to filter lines. When set, only matching lines are returned, then offset/limit apply to the matches.'
      ),
    ignoreCase: tool.schema
      .boolean()
      .optional()
      .describe('Case-insensitive pattern matching (default: false)'),
    maxTokens: tool.schema
      .number()
      .optional()
      .describe(
        `Raise the result budget in tokens (default ${DEFAULT_READ_MAX_TOKENS}, server ceiling ${MAX_READ_MAX_TOKENS}). A wider budget buys fewer round trips, it does not replace the cursor: a result cut at any budget still ends in a \`nextSince\` that has to be followed with \`since\`, and the token you spend re-reading the same bytes is the token you saved. Use \`pattern\` when you only want matching lines, and \`maxTokens\` when the output is genuinely large and you need most of it in one result. Measured across 15 real runs, raising the budget was chosen over following \`nextSince\` every time it was offered, and the cursor was then re-typed from memory and came out wrong.`
      ),
    since: tool.schema
      .number()
      .optional()
      .describe(
        'Absolute character offset to resume from, as reported by a previous nextSince. Returns the raw stream with no line numbering. Follow nextSince until it is absent to get the output in full.'
      ),
    all: tool.schema
      .boolean()
      .optional()
      .describe(
        'Remove the result budget entirely. Unbounded and can overflow your context; use only when a bounded read plus since-paging would take more calls than the data is worth.'
      ),
  },
  async execute(args) {
    const session = manager.get(args.id)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    const budget = resolveBudget(args)

    // `since` is a character cursor and `offset` a line cursor; they answer
    // different questions and cannot be combined. `since` wins, and says so.
    if (args.since !== undefined) {
      return handleSinceRead(args, session, budget)
    }

    const offset = args.offset ?? 0
    const limit = args.limit ?? DEFAULT_READ_LIMIT

    if (args.pattern) {
      return handlePatternRead(
        args,
        args.id,
        args.pattern,
        args.ignoreCase,
        session,
        offset,
        limit,
        budget
      )
    } else {
      return handlePlainRead(args, session, offset, limit, budget)
    }
  },
})
