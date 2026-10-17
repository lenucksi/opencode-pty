import type { GhosttyCell, RGB } from 'ghostty-web'

/**
 * Turning a cell's style into something a consumer can render.
 *
 * Split out of `screen.ts` so that file stays about replaying bytes into a grid:
 * the palette reading, the style comparison and the run bookkeeping are their own
 * concern, and they are shared by the coordinate `spans` and the text
 * `styledLines` so the two can never disagree about what "red on blue, bold" means.
 */

/** Bit positions of `CellFlags` in ghostty-web. Kept local so a rename upstream is a compile error, not a silent misread. */
const FLAG_BOLD = 1 << 0
const FLAG_ITALIC = 1 << 1
const FLAG_UNDERLINE = 1 << 2
const FLAG_STRIKETHROUGH = 1 << 3
const FLAG_INVERSE = 1 << 4
const FLAG_FAINT = 1 << 7

/**
 * One run of cells that share a style, carrying the characters themselves.
 *
 * `ColorSpan` answers "where is something non-default" in CELL coordinates, which
 * is enough for a consumer that owns a terminal. A consumer that does not - the
 * TUI panel - cannot use that, because a wide character is one character and two
 * cells, so a cell column does not index the row's text. This is the same run
 * already resolved to text, so a renderer can emit it verbatim. It also keeps the
 * spaces a background colour sits on, which `lines` trims away.
 */
export interface StyledRun {
  text: string
  /** `#rrggbb`, or omitted when the run uses the default foreground. */
  fg?: string
  /** `#rrggbb`, or omitted when the run uses the default background. */
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  faint?: boolean
}

export interface ColorSpan extends Omit<StyledRun, 'text'> {
  /** Zero-based row. */
  row: number
  /** Zero-based column of the first cell in the run. */
  col: number
  /** Number of cells, counted in grid cells including wide-char continuations. */
  length: number
}

export function hex(color: RGB): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

export function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/**
 * The visible style of a cell, relative to the terminal's defaults.
 *
 * Shared by the coordinate `spans` and the text `styledLines`, so the two can
 * never disagree about what "red on blue, bold" means.
 */
export function styleFields(
  cell: GhosttyCell,
  defaultFg: RGB,
  defaultBg: RGB
): Omit<StyledRun, 'text'> {
  const fg = { r: cell.fg_r, g: cell.fg_g, b: cell.fg_b }
  const bg = { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b }
  const style: Omit<StyledRun, 'text'> = {}
  if (!sameColor(fg, defaultFg)) style.fg = hex(fg)
  if (!sameColor(bg, defaultBg)) style.bg = hex(bg)
  if (cell.flags & FLAG_BOLD) style.bold = true
  if (cell.flags & FLAG_ITALIC) style.italic = true
  if (cell.flags & FLAG_UNDERLINE) style.underline = true
  if (cell.flags & FLAG_STRIKETHROUGH) style.strikethrough = true
  if (cell.flags & FLAG_INVERSE) style.inverse = true
  if (cell.flags & FLAG_FAINT) style.faint = true
  return style
}

export function toSpan(
  row: number,
  col: number,
  length: number,
  cell: GhosttyCell,
  defaultFg: RGB,
  defaultBg: RGB
): ColorSpan {
  return { row, col, length, ...styleFields(cell, defaultFg, defaultBg) }
}

/**
 * Drop trailing runs that only pad a row with default-styled blanks.
 *
 * A row is emitted from its cells, so it is as wide as the screen and every line
 * would end in 200 spaces. A run that carries a background is kept whole: those
 * spaces are the colour, and the boot menu's blue box is exactly that. A run with
 * no background has nothing its trailing spaces can show, so they go.
 */
export function trimTrailingBlankRuns(runs: StyledRun[]): StyledRun[] {
  while (runs.length > 0) {
    const last = runs[runs.length - 1]
    if (!last || last.bg !== undefined || last.inverse === true) break
    const trimmed = last.text.replace(/\s+$/, '')
    if (trimmed === '') runs.pop()
    else {
      last.text = trimmed
      break
    }
  }
  return runs
}
