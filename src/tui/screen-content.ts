import type { StyledRun } from '../plugin/pty/screen.ts'
import { cellWidth } from './cell-width.ts'

/**
 * Decoding a session's rendered screen out of the server's response.
 *
 * Split out of `lib.ts`, which had grown past the size the repository flags: the
 * screen's shape and its colour runs are one subject, and the sidebar's pure
 * logic (row labels, durations, ordering) is another.
 */

/**
 * Decode a `/api/sessions/:id/screen` response into displayable text.
 *
 * The endpoint returns the RENDERED screen - one string per row, trailing blanks
 * already removed - not the bytes the program wrote. That distinction is the whole
 * point: `buffer/plain` is `Bun.stripANSI(raw)`, so a cursor move is deleted along
 * with the colour codes and a full-screen program's output arrives unpainted with its
 * layout gone. The screen carries the layout.
 *
 * The rows are joined with newlines and nothing else. A line too wide for the screen
 * therefore occupies two rows here too, which is what the program itself shows; the
 * response's `continuedRows` is there for a reader who needs to know they are one line.
 *
 * Returns '' for anything unreadable rather than throwing: a dialog that cannot show
 * output should show an empty box, not take the panel's refresh down with it.
 */
export interface ScreenContent {
  /** Every drawn row, top to bottom, joined by newlines. */
  text: string
  /**
   * Style runs parallel to `text`'s lines: `runs[i]` is line `i`, or `[]` when the
   * row is plain - scrollback, or a row with nothing styled.
   *
   * Parallel rather than a map keyed by row, because the trailing-blank trim below
   * drops lines and their runs have to go with them; two structures keyed
   * independently would drift the moment one of them was trimmed alone.
   */
  runs: StyledRun[][]
}

/** A screen made of plain lines and nothing else - messages, and test fixtures. */
export function screenContent(text: string): ScreenContent {
  const lines = text === '' ? [] : text.split('\n')
  return { text, runs: lines.map(() => []) }
}

export function decodeScreen(raw: unknown): ScreenContent {
  const rowsOf = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((line): line is string => typeof line === 'string')
    }
    if (value && typeof value === 'object') {
      const lines = (value as { lines?: unknown }).lines
      if (Array.isArray(lines))
        return lines.filter((line): line is string => typeof line === 'string')
    }
    return []
  }
  // A bare array is accepted so a caller that gets the body directly is not punished
  // for it, exactly as `decodeBuffer` accepted a bare string.
  const lines = rowsOf(raw)
  const styled = styledRowsOf(raw)
  // The server sends history rows first, then the visible screen, and styles only
  // the visible rows. So the styled rows are a suffix of `lines`.
  const firstStyled = Math.max(0, lines.length - styled.length)
  const runs: StyledRun[][] = lines.map((_, index) =>
    index >= firstStyled ? (styled[index - firstStyled] ?? []) : []
  )
  // Trailing blanks are the screen's SHAPE, not the program's output: a fresh run
  // prints its first lines at the top and the screen still has its full height - the
  // reader measured a console that scrolled through blank rows and showed a scrollbar
  // while the screen was not even full. The stage keeps the rows; the consumer drops
  // the blank tail - but only the rows that a background does not reach, or the boot
  // menu's blue box would lose its padding lines.
  const blank = (index: number): boolean => {
    if ((lines[index] ?? '').trim() !== '') return false
    return !(runs[index] ?? []).some((run) => run.bg !== undefined || run.inverse === true)
  }
  let end = lines.length
  while (end > 0 && blank(end - 1)) end -= 1
  return { text: lines.slice(0, end).join('\n'), runs: runs.slice(0, end) }
}

/**
 * `styledLines` from the response, validated.
 *
 * The body is untrusted JSON, so every run is checked before it can reach a
 * renderer: a row that is not an array of objects with a string `text` is dropped
 * whole rather than half-rendered.
 */
function styledRowsOf(raw: unknown): StyledRun[][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const value = (raw as { styledLines?: unknown }).styledLines
  if (!Array.isArray(value)) return []
  return value.map((row): StyledRun[] => {
    if (!Array.isArray(row)) return []
    return row.filter(isStyledRun)
  })
}

function isStyledRun(value: unknown): value is StyledRun {
  return (
    !!value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string'
  )
}

/**
 * The widest row of a screen, in cells.
 *
 * The panel shows a screen the program drew for a wider terminal, so this is what
 * decides whether the console needs a sideways scrollbar at all.
 */
export function widestRow(screen: ScreenContent): number {
  let widest = 0
  for (const line of screen.text === '' ? [] : screen.text.split('\n')) {
    const width = cellWidth(line)
    if (width > widest) widest = width
  }
  return widest
}
