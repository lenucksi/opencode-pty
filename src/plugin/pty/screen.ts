import { Ghostty } from 'ghostty-web'
import type { GhosttyCell, RGB } from 'ghostty-web'

/**
 * Renders a PTY's raw output into the screen a user would actually see.
 *
 * `pty_read` hands over the byte stream. For anything that paints a screen - a
 * TUI, a pager, `top`, a progress display - that stream is not the information
 * the reader wants: the layout is implicit in escape sequences, cursor moves and
 * erase-line codes, and a human reading it has to run a terminal emulator in
 * their head to find out what is on screen. The last line of a full-screen
 * repaint says nothing about what the program looks like.
 *
 * So the screen is reconstructed by replaying the buffer through the same VT
 * parser the web UI uses, and the result is a two-dimensional grid.
 *
 * Replay, not a live emulator per session: measured, one terminal costs ~21 MB
 * of heap, so a hundred live sessions would be two gigabytes. Replaying costs
 * 2-13 ms for a 409 kB buffer, and the read that follows is a flat ~30 ms
 * because it crosses the WASM boundary once per cell. No per-session state also
 * means archived and live sessions render identically, and there is nothing to
 * keep in sync when output arrives in pieces.
 */

/** Bit positions of `CellFlags` in ghostty-web. Kept local so a rename upstream is a compile error, not a silent misread. */
const FLAG_BOLD = 1 << 0
const FLAG_ITALIC = 1 << 1
const FLAG_UNDERLINE = 1 << 2
const FLAG_STRIKETHROUGH = 1 << 3
const FLAG_INVERSE = 1 << 4
const FLAG_FAINT = 1 << 7

export interface ColorSpan {
  /** Zero-based row. */
  row: number
  /** Zero-based column of the first cell in the run. */
  col: number
  /** Number of cells, counted in grid cells including wide-char continuations. */
  length: number
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

/**
 * How much of a session's output one render replays.
 *
 * Measured on this build (240x80, a 1 MB retained buffer, 12 repeated renders):
 *
 * | replay window | steady-state heap | per render |
 * | ------------- | ----------------- | ---------- |
 * | 64 kB         | 22 MB             | 32 ms      |
 * | 128 kB        | 40 MB             | 44 ms      |
 * | 256 kB        | 40 MB             | 57 ms      |
 * | 512 kB        | 73 MB             | 60 ms      |
 * | 1 MB          | 139 MB            | 51 ms      |
 *
 * 256 kB costs the same memory as 128 kB with twice the headroom. It holds about
 * 3000 lines of 80 characters, or five full-screen repaints at 240x80 - and a
 * TUI's last repaint is self-contained, so a screen rendered from the last 64 kB
 * is byte-identical to one rendered from the last megabyte (verified).
 *
 * A partial replay is a reconstruction, not a lie: a cell painted before the
 * window and never touched again comes back blank. `ScreenSnapshot` reports the
 * fraction so the caller can say so.
 */
export const DEFAULT_REPLAY_WINDOW = 262_144

/**
 * Largest screen a single render will build, in cells.
 *
 * Reading the screen costs one host object per cell, and the cost grows faster
 * than linearly. Measured on this build, rendering `x` once:
 *
 * | geometry | cells | time  |
 * | -------- | ----- | ----- |
 * | 240x80   | 19 200 | 51 ms |
 * | 400x120  | 48 000 | 104 ms|
 * | 500x200  | 100 000| 415 ms|
 * | 600x300  | 180 000| 1.2 s |
 * | 1000x1000| 1 000 000 | 25 s |
 *
 * 100 000 cells is a terminal far larger than any real one, and it costs a
 * quarter of a second. The unbounded case is not hypothetical: the tool's
 * per-dimension clamp allows 1000x1000, which is a 25-second hang from a single
 * argument.
 */
export const MAX_SCREEN_CELLS = 100_000

export interface FittedScreen {
  cols: number
  rows: number
  /** True when the request was reduced to fit the cell budget. */
  clamped: boolean
}

/**
 * Fit a requested geometry into the render budget, preserving its shape.
 *
 * Scaling both axes rather than clamping one keeps the layout's proportions, so a
 * caller asking "what does this look like at 600x300" gets a proportionally
 * smaller screen instead of a letterboxed one whose wrapping is an artefact of
 * the clamp.
 */
export function fitScreenSize(cols: number, rows: number, budget = MAX_SCREEN_CELLS): FittedScreen {
  const cells = cols * rows
  if (cells <= budget) return { cols, rows, clamped: false }
  const scale = Math.sqrt(budget / cells)
  return {
    cols: Math.max(2, Math.floor(cols * scale)),
    rows: Math.max(1, Math.floor(rows * scale)),
    clamped: true,
  }
}

export interface ScreenSnapshot {
  cols: number
  rows: number
  /** One string per row, with trailing blanks removed. */
  lines: string[]
  cursor: { x: number; y: number; visible: boolean; style: string }
  /** True when the program is on the alternate screen, which has no scrollback. */
  alternate: boolean
  /** Lines retained above the visible screen. */
  scrollback: number
  /** Runs that differ from the default foreground, background or style. */
  spans: ColorSpan[]
  /**
   * How much of the retained output was replayed.
   *
   * A screen rebuilt from only the tail of a stream is a reconstruction: a
   * program that painted a row long ago and never touched it again will not have
   * that row in the replayed window. Reporting the fraction keeps the result
   * honest instead of implying the whole session was rendered.
   */
  replayedChars: number
  totalChars: number
}

/**
 * One shared WASM instance, created on first use.
 *
 * `Ghostty.load()` pulls in a ~1 MB module and initialises WASM. Doing that at
 * import time would slow every plugin load for everyone who never calls
 * `pty_screen`, so it is deferred to the first call that needs it.
 */
let ghosttyPromise: Promise<Ghostty> | null = null

function loadGhostty(): Promise<Ghostty> {
  ghosttyPromise ??= Ghostty.load().catch((error: unknown) => {
    // Clear the memo so a transient failure does not poison every later call.
    ghosttyPromise = null
    throw error
  })
  return ghosttyPromise
}

/** Test seam: reports whether the WASM module is already loaded. */
export function isScreenEmulatorLoaded(): boolean {
  return ghosttyPromise !== null
}

function hex(color: RGB): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/** The text of one cell, including any combining marks it carries. */
function cellText(
  terminal: { getGraphemeString: (row: number, col: number) => string },
  row: number,
  col: number,
  cell: GhosttyCell
): string {
  if (cell.codepoint === 0) return ' '
  // `codepoint` is only the first codepoint of a grapheme. A flag emoji or a
  // ZWJ sequence would come out as its first piece without this.
  if (cell.grapheme_len > 0) {
    const full = terminal.getGraphemeString(row, col)
    if (full !== '') return full
  }
  return String.fromCodePoint(cell.codepoint)
}

/**
 * Replay `raw` at the given geometry and describe the resulting screen.
 *
 * @param raw        Everything the session retained, in order.
 * @param cols       Terminal width to render at.
 * @param rows       Terminal height to render at.
 * @param maxReplay  Upper bound on how much of `raw` to feed the emulator.
 *                   The tail is kept, because the visible screen is at the end.
 */
export async function renderScreen(
  raw: string,
  cols: number,
  rows: number,
  maxReplay = DEFAULT_REPLAY_WINDOW
): Promise<ScreenSnapshot> {
  const ghostty = await loadGhostty()
  const replayedChars = Math.min(raw.length, maxReplay)
  const replayed = replayedChars === raw.length ? raw : raw.slice(raw.length - replayedChars)

  // The emulator's own resolved defaults are what "no colour" is measured
  // against. Reading them back rather than assuming a palette is what keeps a
  // span list meaningful: hardcoding a fg here would report every unstyled cell as
  // coloured if the emulator's default ever differed.
  const terminal = ghostty.createTerminal(cols, rows)

  try {
    if (replayed !== '') terminal.write(replayed)
    terminal.update()

    const defaults = terminal.getColors()
    const defaultFg = defaults.foreground
    const defaultBg = defaults.background
    const rawCursor = terminal.getCursor()

    const lines: string[] = []
    const spans: ColorSpan[] = []

    for (let y = 0; y < rows; y++) {
      const cells = terminal.getLine(y) ?? []
      let line = ''
      // A run is only interesting while something is non-default, so the
      // current run is tracked separately from the line text.
      let run: { col: number; length: number; cell: GhosttyCell } | null = null
      let previousWasWide = false
      const flush = (): void => {
        if (!run) return
        spans.push(toSpan(y, run.col, run.length, run.cell, defaultFg, defaultBg))
        run = null
      }

      for (let x = 0; x < cells.length; x++) {
        const cell = cells[x]
        if (!cell) continue

        // A cell that follows a double-width character is its continuation: the
        // character already covers both screen columns. Emitting a placeholder
        // there would put a phantom space into the text, so a CJK line would come
        // back as "日 本 語" and be read as three separate words.
        if (previousWasWide) {
          previousWasWide = false
          continue
        }
        line += cellText(terminal, y, x, cell)
        previousWasWide = cell.width > 1

        if (isDefaultCell(cell, defaultFg, defaultBg)) {
          flush()
          continue
        }
        if (run && sameStyle(run.cell, cell)) {
          run.length += 1
          continue
        }
        flush()
        run = { col: x, length: 1, cell }
      }
      flush()

      // Trailing blanks are screen shape, not content: a 240-column row of a
      // progress bar would otherwise be mostly padding.
      lines.push(line.replace(/\s+$/, ''))
    }

    return {
      cols,
      rows,
      lines,
      cursor: {
        x: rawCursor.x,
        y: rawCursor.y,
        // Typed as boolean, delivered as 0/1.
        visible: rawCursor.visible === true || (rawCursor.visible as unknown) === 1,
        style: rawCursor.style,
      },
      alternate: terminal.isAlternateScreen(),
      scrollback: terminal.getScrollbackLength(),
      spans,
      replayedChars,
      totalChars: raw.length,
    }
  } finally {
    // The WASM allocation is per terminal and not garbage collected; without
    // this the shared module grows without bound across calls.
    terminal.free()
  }
}

function isDefaultCell(cell: GhosttyCell, defaultFg: RGB, defaultBg: RGB): boolean {
  return (
    cell.flags === 0 &&
    sameColor({ r: cell.fg_r, g: cell.fg_g, b: cell.fg_b }, defaultFg) &&
    sameColor({ r: cell.bg_r, g: cell.bg_g, b: cell.bg_b }, defaultBg)
  )
}

/** Two cells belong to one run when everything visible about them matches. */
function sameStyle(a: GhosttyCell, b: GhosttyCell): boolean {
  return (
    a.fg_r === b.fg_r &&
    a.fg_g === b.fg_g &&
    a.fg_b === b.fg_b &&
    a.bg_r === b.bg_r &&
    a.bg_g === b.bg_g &&
    a.bg_b === b.bg_b &&
    a.flags === b.flags
  )
}

function toSpan(
  row: number,
  col: number,
  length: number,
  cell: GhosttyCell,
  defaultFg: RGB,
  defaultBg: RGB
): ColorSpan {
  const fg = { r: cell.fg_r, g: cell.fg_g, b: cell.fg_b }
  const bg = { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b }
  const span: ColorSpan = { row, col, length }
  if (!sameColor(fg, defaultFg)) span.fg = hex(fg)
  if (!sameColor(bg, defaultBg)) span.bg = hex(bg)
  if (cell.flags & FLAG_BOLD) span.bold = true
  if (cell.flags & FLAG_ITALIC) span.italic = true
  if (cell.flags & FLAG_UNDERLINE) span.underline = true
  if (cell.flags & FLAG_STRIKETHROUGH) span.strikethrough = true
  if (cell.flags & FLAG_INVERSE) span.inverse = true
  if (cell.flags & FLAG_FAINT) span.faint = true
  return span
}
