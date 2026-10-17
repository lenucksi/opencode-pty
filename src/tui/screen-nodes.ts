import { jsx } from '@opentui/solid/jsx-runtime'
import type { StyledRun } from '../plugin/pty/screen.ts'
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
export function screenNodes(screen: ScreenContent): unknown[] {
  const lines = screen.text === '' ? [] : screen.text.split('\n')
  return lines.map((line, index) => {
    const runs = screen.runs[index]
    const cells: unknown[] =
      runs === undefined || runs.length === 0
        ? [jsx('text', { wrapMode: 'none', flexShrink: 0, children: line })]
        : runs.map((run) =>
            jsx('text', {
              wrapMode: 'none',
              flexShrink: 0,
              fg: run.fg,
              bg: run.bg,
              attributes: runAttributes(run),
              children: run.text,
            })
          )
    return jsx('box', {
      flexDirection: 'row',
      width: '100%',
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
