/**
 * Character budgeting for tool output, shared by the live and the archived
 * read paths so the two can never disagree.
 *
 * Why this exists: `pty_read` used to clamp every line at a fixed 2000
 * characters with a bare `...`. That destroyed the information at the return
 * type, bounded nothing (`500 lines x 2000 chars` is the whole 1 MB buffer), and
 * measured against 225 live sessions it silently withheld 35 % of all data. The
 * quantity that actually has to be bounded is the size of one result, so that is
 * what is bounded here.
 */

/** One line as it will be delivered. */
export interface LineSlice {
  text: string
  /** Characters actually delivered. */
  shownChars: number
  /** Full length of the source line. */
  totalChars: number
  truncated: boolean
}

export interface BudgetedLines {
  slices: LineSlice[]
  /** Plain text of each slice, for callers that only need the text. */
  lines: string[]
  /**
   * Line content handed over, which is what the budget governs.
   *
   * Deliberately *not* the same number as the stream characters a caller
   * receives: the newlines between lines cost nothing in the budget but are
   * real characters in the output. Callers that report `chars="X/Y"` must
   * derive it from cursor arithmetic, not from this field, or the two halves of
   * the ratio are in different units.
   */
  consumedChars: number
  /** 0 or 1: the budget can cut at most one line. */
  truncatedLines: number
  /**
   * Index into the input of the line that was cut, or null. The line appears in
   * `slices` already cut.
   */
  cutIndex: number | null
  /**
   * Absolute character offset to resume from, or null when the whole input was
   * delivered.
   */
  nextSince: number | null
}

/**
 * Take whole lines while they fit, then cut at most one further line.
 *
 * `offsetOfLine` maps an input index to the absolute character offset where that
 * line starts, so a cut can be resumed exactly. Pass it only when `budget` is
 * set; the unbounded path needs no offsets.
 */
export function applyLineBudget(
  lines: readonly string[],
  budget: number | undefined,
  offsetOfLine: (index: number) => number | null
): BudgetedLines {
  if (budget === undefined) {
    return {
      slices: lines.map((text) => ({
        text,
        shownChars: text.length,
        totalChars: text.length,
        truncated: false,
      })),
      lines: [...lines],
      consumedChars: lines.reduce((sum, line) => sum + line.length, 0),
      truncatedLines: 0,
      cutIndex: null,
      nextSince: null,
    }
  }

  const slices: LineSlice[] = []
  let remaining = Math.max(0, budget)
  let shownChars = 0
  let cutIndex: number | null = null
  let nextSince: number | null = null

  for (const [index, line] of lines.entries()) {
    if (line.length <= remaining) {
      slices.push({
        text: line,
        shownChars: line.length,
        totalChars: line.length,
        truncated: false,
      })
      remaining -= line.length
      shownChars += line.length
      continue
    }
    const take = remaining
    if (take > 0) {
      slices.push({
        text: line.slice(0, take),
        shownChars: take,
        totalChars: line.length,
        truncated: true,
      })
      shownChars += take
    }
    cutIndex = index
    const lineStart = offsetOfLine(index)
    // Resume exactly where delivery stopped, not at the next line boundary: a
    // cut line has no usable line offset.
    nextSince = lineStart === null ? null : lineStart + take
    remaining = 0
    break
  }

  return {
    slices,
    lines: slices.map((slice) => slice.text),
    consumedChars: shownChars,
    truncatedLines: cutIndex === null ? 0 : 1,
    cutIndex,
    nextSince,
  }
}

/**
 * A raw character slice, bounded and resumable.
 *
 * `nextSince` is `null` exactly when the whole remainder was delivered, so a
 * caller can page by following it until it disappears.
 */
export interface BoundedRawResult {
  /** The delivered characters; the tail of a cut is not included. */
  text: string
  shownChars: number
  /** Characters available from `since` to the end of the retained buffer. */
  totalChars: number
  /** Absolute character offset `text` starts at. */
  since: number
  /** Absolute character offset to pass back to continue, or null when done. */
  nextSince: number | null
  truncated: boolean
}

export function buildBoundedRaw(raw: string, offset: number, budget?: number): BoundedRawResult {
  if (budget === undefined) {
    return {
      text: raw,
      shownChars: raw.length,
      totalChars: raw.length,
      since: offset,
      nextSince: null,
      truncated: false,
    }
  }
  const shown = raw.slice(0, Math.max(0, budget))
  const truncated = shown.length < raw.length
  return {
    text: shown,
    shownChars: shown.length,
    totalChars: raw.length,
    since: offset,
    nextSince: truncated ? offset + shown.length : null,
    truncated,
  }
}
