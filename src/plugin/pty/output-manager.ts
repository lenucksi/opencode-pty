import { applyLineBudget, type LineSlice } from './read-budget.ts'

export type { LineSlice }
import type { PTYSession, ReadResult, SearchResult } from './types.ts'

/**
 * A read result plus the accounting the old shape threw away.
 *
 * `ReadResult.hasMore` is line arithmetic only, which is why a line cut in half
 * used to be reported as "end of buffer": once the last line is returned the
 * line condition is satisfied regardless of whether that line was whole. These
 * fields let the caller compute the honest answer.
 */
export interface BoundedReadResult extends ReadResult {
  /** Per-line delivery detail; `lines` is the same text without the metadata. */
  slices: LineSlice[]
  /** Characters this result actually delivers. */
  shownChars: number
  /** Characters currently retained in the buffer. */
  bufferChars: number
  /** Returned lines that were cut by the budget. */
  truncatedLines: number
  /** Absolute character offset to pass back to continue, or null when done. */
  nextSince: number | null
  /** Absolute character offset this result starts at. */
  since: number
}

export interface BoundedSearchResult extends SearchResult {
  shownChars: number
  truncatedLines: number
}

export class OutputManager {
  write(session: PTYSession, data: string): boolean {
    try {
      session.process?.write(data)
      return true
    } catch {
      return true // allow write to exited process for tests
    }
  }

  /**
   * Read lines from `offset`, bounded by a character budget.
   *
   * `hasMore` is the union of two conditions: more lines exist, or a line was
   * cut. The old line-only arithmetic reported "end of buffer" for a line that
   * had been cut in half, which is how a frozen TUI read as a stable screen.
   */
  read(
    session: PTYSession,
    offset: number = 0,
    limit?: number,
    budget?: number
  ): BoundedReadResult {
    const lines = session.buffer.read(offset, limit)
    const totalLines = session.buffer.length
    const start = Math.max(0, offset)
    const bufferStart = session.buffer.bufferStart
    const since = session.buffer.lineStartOffset(start) ?? bufferStart

    const budgeted = applyLineBudget(lines, budget, (index) =>
      session.buffer.lineStartOffset(start + index)
    )

    const delivered = start + budgeted.lines.length
    const moreLinesExist = delivered < totalLines
    const hasMore = budgeted.cutIndex !== null || moreLinesExist

    // Where the delivery stopped, in absolute stream characters. This is also
    // the numerator of `chars="X/Y"`, so it has to include the newlines between
    // delivered lines: the caller really did receive those characters, and
    // `bufferChars` counts them too.
    const endOffset =
      budgeted.nextSince ??
      session.buffer.lineStartOffset(delivered) ??
      session.buffer.endCharOffset()

    return {
      lines: budgeted.lines,
      slices: budgeted.slices,
      totalLines,
      offset: start,
      hasMore,
      shownChars: Math.max(0, endOffset - since),
      bufferChars: session.buffer.charLength,
      truncatedLines: budgeted.truncatedLines,
      nextSince: hasMore ? endOffset : null,
      since,
    }
  }

  /** Same budget discipline for pattern results. */
  search(
    session: PTYSession,
    pattern: RegExp,
    offset: number = 0,
    limit?: number,
    budget?: number
  ): BoundedSearchResult {
    const allMatches = session.buffer.search(pattern)
    const totalMatches = allMatches.length
    const totalLines = session.buffer.length
    const start = Math.max(0, offset)
    const limited =
      limit !== undefined ? allMatches.slice(start, start + limit) : allMatches.slice(start)

    const texts = limited.map((match) => match.text)
    const budgeted = applyLineBudget(texts, budget, () => null)
    const kept = limited.slice(0, budgeted.lines.length).map((match, index) => ({
      lineNumber: match.lineNumber,
      text: budgeted.lines[index] ?? '',
    }))

    return {
      matches: kept,
      totalMatches,
      totalLines,
      offset: start,
      hasMore: budgeted.truncatedLines === 1 || start + kept.length < totalMatches,
      shownChars: budgeted.consumedChars,
      truncatedLines: budgeted.truncatedLines,
    }
  }
}
