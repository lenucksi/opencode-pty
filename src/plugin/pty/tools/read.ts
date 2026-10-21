import { tool } from '@opencode-ai/plugin'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_TOKENS,
  MAX_READ_MAX_TOKENS,
} from '../../../shared/constants.ts'
import { formatLine, formatPtyOutputBlock, TRUNCATION_MARKER } from '../formatters.ts'
import type { BoundedSearchResult } from '../output-manager.ts'
import { getPtyManager } from '../manager.ts'
import type { PTYSessionInfo } from '../types.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './read.txt'
import {
  appendSessionReminders,
  formatPtyOutput,
  resolveBudget,
  validateAndCreateRegex,
  type ReadArgs,
} from './read-support.ts'

/**
 * Handles pattern-based reading and formatting
 */
async function handlePatternRead(
  args: ReadArgs,
  id: string,
  pattern: string,
  ignoreCase: boolean | undefined,
  session: PTYSessionInfo,
  offset: number,
  limit: number,
  budget: number | undefined
): Promise<string> {
  const regex = validateAndCreateRegex(pattern, ignoreCase)

  const result: BoundedSearchResult | null = await getPtyManager().search(
    id,
    regex,
    offset,
    limit,
    budget
  )
  if (!result) {
    throw await buildSessionNotFoundError(id)
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
async function handlePlainRead(
  args: ReadArgs,
  session: PTYSessionInfo,
  offset: number,
  limit: number,
  budget: number | undefined
): Promise<string> {
  const result = await getPtyManager().read(args.id, offset, limit, budget)
  if (!result) {
    throw await buildSessionNotFoundError(args.id)
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
async function handleSinceRead(
  args: ReadArgs,
  session: PTYSessionInfo,
  budget: number | undefined
): Promise<string> {
  const since = Math.max(0, Math.floor(args.since ?? 0))
  const result = await getPtyManager().readSince(args.id, since, budget)
  if (!result) {
    throw await buildSessionNotFoundError(args.id)
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
    const session = await getPtyManager().get(args.id)
    if (!session) {
      throw await buildSessionNotFoundError(args.id)
    }

    const budget = resolveBudget(args)

    // `since` is a character cursor and `offset` a line cursor; they answer
    // different questions and cannot be combined. `since` wins, and says so.
    if (args.since !== undefined) {
      return await handleSinceRead(args, session, budget)
    }

    const offset = args.offset ?? 0
    const limit = args.limit ?? DEFAULT_READ_LIMIT

    if (args.pattern) {
      return await handlePatternRead(
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
      return await handlePlainRead(args, session, offset, limit, budget)
    }
  },
})
