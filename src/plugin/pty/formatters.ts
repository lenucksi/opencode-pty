import { formatDuration } from '../../web/shared/session-meta.ts'
import type { PTYSessionInfo } from './types.ts'

export function formatSessionInfo(session: PTYSessionInfo): string[] {
  const timedOutInfo = session.timedOut ? ' | timed out' : ''
  const exitInfo = session.exitCode !== undefined ? ` | exit: ${session.exitCode}` : ''
  const exitSignal = session.exitSignal ? ` | signal: ${session.exitSignal}` : ''
  const timeoutInfo =
    session.timeoutSeconds !== undefined ? ` | timeout: ${session.timeoutSeconds}s` : ''
  return [
    `[${session.id}] ${session.title}`,
    `  Command: ${session.command} ${session.args.join(' ')}`,
    `  Status: ${session.status}${timedOutInfo}${exitInfo}${exitSignal}`,
    `  PID: ${session.pid}${timeoutInfo}`,
    `  Lines: ${session.lineCount} | Chars: ${session.charCount} | Size: ${session.cols}x${session.rows}`,
    `  Workdir: ${session.workdir}`,
    `  Started: ${session.createdAt}`,
    ...(session.endedAt === undefined
      ? []
      : [
          `  Ended: ${session.endedAt}`,
          `  Duration: ${formatDuration(session.createdAt, session.endedAt)}`,
        ]),
    '',
  ]
}

export interface FormattedLine {
  /** Line-number gutter plus as much of the line as the budget allowed. */
  text: string
  truncated: boolean
  /** Characters of the line actually present in `text`, excluding the gutter. */
  shownChars: number
  /** Full length of the line before any cut. */
  totalChars: number
}

/**
 * Render one numbered line within a character budget.
 *
 * The old version took a fixed 2000 and appended a bare `...`. That destroyed the
 * information at the return type: the caller could not tell a cut from three
 * literal dots, and nothing recorded how much was withheld. It also did not
 * bound anything, because 500 lines x 2000 chars is the whole buffer.
 *
 * `budget` is the remaining character budget for the whole result, not a
 * per-line limit, and the caller is expected to aggregate the returned counts.
 */
export function formatLine(line: string, lineNum: number, budget: number): FormattedLine {
  const gutter = `${lineNum.toString().padStart(5, '0')}| `
  const available = Math.max(0, budget)
  const truncated = line.length > available
  const shown = truncated ? line.slice(0, available) : line
  return {
    text: `${gutter}${shown}`,
    truncated,
    shownChars: shown.length,
    totalChars: line.length,
  }
}

/** The marker a caller can search for, instead of a bare `...`. */
export const TRUNCATION_MARKER = (shownChars: number, totalChars: number): string =>
  `… [truncated: ${shownChars} of ${totalChars} chars]`

/** Metadata the output block must carry so a caller can detect a cut. */
export interface OutputBlockMeta {
  /** 1-based part number and total, when the result was cut. */
  part?: { index: number; total: number }
  /** Absolute character offset this result starts at, for byte-exact paging. */
  since?: number
  /** Absolute character offset to pass back to continue, when anything remains. */
  nextSince?: number | null
  /** How much of the buffer this result actually shows. */
  chars?: { shown: number; total: number }
  truncatedLines?: number
  all?: boolean
  pattern?: string
}

export function formatPtyOutputBlock(
  id: string,
  status: string,
  lines: string[],
  meta: OutputBlockMeta = {}
): string {
  const attrs: string[] = [`id="${id}"`, `status="${status}"`]
  if (meta.pattern) attrs.push(`pattern="${meta.pattern}"`)
  if (meta.part) attrs.push(`part="${meta.part.index}/${meta.part.total}"`)
  if (meta.since !== undefined) attrs.push(`since="${meta.since}"`)
  if (meta.nextSince !== undefined && meta.nextSince !== null) {
    attrs.push(`nextSince="${meta.nextSince}"`)
  }
  if (meta.chars) attrs.push(`chars="${meta.chars.shown}/${meta.chars.total}"`)
  if (meta.truncatedLines)
    attrs.push(`truncated="${true}"`, `truncatedLines="${meta.truncatedLines}"`)
  if (meta.all) attrs.push('all="true"')
  return [`<pty_output ${attrs.join(' ')}>`, ...lines, `</pty_output>`].join('\n')
}
