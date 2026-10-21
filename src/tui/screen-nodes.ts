import { jsx } from '@opentui/solid/jsx-runtime'
import type { StyledRun } from '../plugin/pty/screen.ts'
import { cellWidth, sliceCells } from './cell-width.ts'
import type { ScreenContent } from './screen-content.ts'

/**
 * Turning a session's coloured screen into opentui nodes.
 *
 * Split out of `session-panel.ts`, which had grown past the size the repository
 * flags. The panel decides WHAT is on screen; this decides how a run becomes a
 * node, and the two are separate subjects.
 */

/**
 * The screen as one row per line, each a `<text>` per styled run.
 *
 * A `<span>` inside a `<text>` would be the natural shape, but measured on opentui
 * 0.6.6 a span's `fg`/`bg` do not reach the rendered cells - only a `<text>`'s do.
 * So each run becomes its own one-row `<text>` in a row box, which is also what
 * keeps a run's colour from bleeding into the next: the cell grid was resolved
 * server-side, and this only places the characters it was handed.
 *
 * `wrapMode: 'none'` and `height: 1`: a run is a slice of a row the emulator
 * already fitted, so a long row must clip rather than wrap into a second line and
 * shift everything below it.
 */

/**
 * One row, cut to the sideways window.
 *
 * The runs are the row's colours; the plain text is the row itself. A row that lies
 * entirely outside the window is dropped (null), and a row that overlaps it keeps
 * only the runs inside - the colour of a run belongs to its own characters, so a run
 * that is half out of the window is cut with them.
 */
function sliceRow(
  line: string,
  runs: StyledRun[] | undefined,
  scrollLeft: number,
  visibleWidth: number
): { text: string; runs: StyledRun[] } | null {
  if (scrollLeft <= 0 && visibleWidth <= 0) return { text: line, runs: runs ?? [] }
  const to = visibleWidth > 0 ? scrollLeft + visibleWidth : Number.MAX_SAFE_INTEGER
  if (runs === undefined || runs.length === 0) {
    const text = sliceCells(line, scrollLeft, to)
    return text === '' ? null : { text, runs: [] }
  }
  const out: StyledRun[] = []
  let cell = 0
  for (const run of runs) {
    const start = cell
    cell += cellWidth(run.text)
    if (cell <= scrollLeft) continue
    if (start >= to) break
    out.push({ ...run, text: sliceCells(run.text, scrollLeft - start, to - start) })
  }
  if (out.length === 0) return null
  return { text: out.map((run) => run.text).join(''), runs: out }
}

export function screenNodes(screen: ScreenContent, scrollLeft = 0, visibleWidth = 0): unknown[] {
  const lines = screen.text === '' ? [] : screen.text.split('\n')
  return lines.map((line, index) => {
    const runs = screen.runs[index]
    // The sideways window: the panel shows a screen drawn for a wider terminal, and
    // only the part the reader asked for is placed. A row outside the window is empty
    // rather than clipped, so the column of runs stays aligned with the text.
    const windowed = sliceRow(line, runs, scrollLeft, visibleWidth)
    const cells: unknown[] =
      windowed === null
        ? []
        : windowed.runs.length === 0
          ? [jsx('text', { wrapMode: 'none', flexShrink: 0, children: windowed.text })]
          : windowed.runs.map((run) =>
              jsx('text', {
                wrapMode: 'none',
                flexShrink: 0,
                fg: run.fg,
                bg: run.bg,
                attributes: runAttributes(run),
                children: run.text,
              })
            )
    // `width: 'auto'`, not `'100%'`: a row that is exactly the viewport wide gives the
    // scrollbox nothing to scroll, so a wide run was clipped at the right edge and
    // could not be reached. Auto lets the row be as wide as its runs are, and the
    // content box around them grows with it - which is what makes the horizontal
    // scrollbar appear.
    return jsx('box', {
      flexDirection: 'row',
      width: 'auto',
      height: 1,
      flexShrink: 0,
      children: cells,
    })
  })
}

/**
 * The opentui attribute bitmask for a run.
 *
 * The bits are opentui's own `TextAttributes` (BOLD 1, DIM 2, ITALIC 4, UNDERLINE
 * 8, BLINK 16, INVERSE 32, HIDDEN 64, STRIKETHROUGH 128), copied rather than
 * imported: `@opentui/core` is not in the host's runtime module map, so a runtime
 * import here could pull in a second copy of the native renderer. Kept beside
 * `screen.ts`'s `FLAG_*` constants, which are local for the same reason.
 */
function runAttributes(run: StyledRun): number {
  return (
    (run.bold ? 1 : 0) |
    (run.faint ? 2 : 0) |
    (run.italic ? 4 : 0) |
    (run.underline ? 8 : 0) |
    (run.inverse ? 32 : 0) |
    (run.strikethrough ? 128 : 0)
  )
}
