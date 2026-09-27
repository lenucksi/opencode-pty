import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import { logPtyEvent } from '../plugin-log.ts'
import { fitScreenSize, renderScreen, type ColorSpan, type ScreenSnapshot } from '../screen.ts'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../constants.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './screen.txt'

/**
 * `pty_screen` — the screen a user would see, instead of the byte stream.
 *
 * Its own tool rather than a `pty_read` mode, because the two answer different
 * questions and want different defaults. `pty_read` is cheap, line-oriented, and
 * what you want for a log. A screen render costs a replay and is only worth it
 * when the layout is the thing you are after; making it a mode of `pty_read`
 * would mean paying for the replay by default, or shipping two unrelated
 * parameter sets behind one name.
 */

function clampDimension(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * One span as `row col length style`.
 *
 * The position has to be in the line: a bare colour without a location is not
 * actionable, and a list of them cannot be matched back to the screen above.
 */
function describeSpan(span: ColorSpan, rowWidth: number): string {
  const style: string[] = []
  if (span.fg !== undefined) style.push(`fg=${span.fg}`)
  if (span.bg !== undefined) style.push(`bg=${span.bg}`)
  if (span.bold === true) style.push('bold')
  if (span.italic === true) style.push('italic')
  if (span.underline === true) style.push('underline')
  if (span.strikethrough === true) style.push('strikethrough')
  if (span.inverse === true) style.push('inverse')
  if (span.faint === true) style.push('faint')
  const row = (span.row + 1).toString().padStart(rowWidth, '0')
  return `${row} ${span.col} ${span.length} ${style.join(' ')}`.trimEnd()
}

export const ptyScreen = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    colors: tool.schema
      .boolean()
      .optional()
      .describe(
        'Include the colour and style of every run of cells that differ from the default (default: false)'
      ),
    width: tool.schema
      .number()
      .optional()
      .describe(
        `Render at this many columns instead of the session's own width (${MIN_TERMINAL_COLS}-${MAX_TERMINAL_COLS}). Does not change the session.`
      ),
    height: tool.schema
      .number()
      .optional()
      .describe(
        `Render at this many rows instead of the session's own height (${MIN_TERMINAL_ROWS}-${MAX_TERMINAL_ROWS}). Does not change the session.`
      ),
  },
  async execute(args) {
    const session: PTYSessionInfo | null = manager.get(args.id)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    // Per-dimension first, so an absurd axis is rejected on its own terms, then a
    // cell budget, because 1000x1000 is within both limits and still a 25-second
    // render.
    const requestedCols = clampDimension(
      args.width,
      MIN_TERMINAL_COLS,
      MAX_TERMINAL_COLS,
      session.cols
    )
    const requestedRows = clampDimension(
      args.height,
      MIN_TERMINAL_ROWS,
      MAX_TERMINAL_ROWS,
      session.rows
    )
    const fitted = fitScreenSize(requestedCols, requestedRows)
    const cols = fitted.cols
    const rows = fitted.rows

    // Live sessions keep the raw stream in the ring buffer; an archived one only
    // has the transcript on disk. Both go through `getRawBuffer` so the two
    // render identically.
    const raw = manager.getRawBuffer(args.id)?.raw
    if (raw === undefined) {
      return [
        `<pty_screen id="${session.id}" cols="${cols}" rows="${rows}">`,
        `(The retained output of this session is not available.)`,
        `</pty_screen>`,
      ].join('\n')
    }

    let snapshot: ScreenSnapshot
    try {
      snapshot = await renderScreen(raw, cols, rows)
    } catch (error) {
      // A failed screen render must not read as "the program printed nothing".
      logPtyEvent('error', 'pty_screen could not render the session screen', error)
      return [
        `<pty_screen id="${session.id}" cols="${cols}" rows="${rows}" error="true">`,
        `(The screen could not be rendered: ${error instanceof Error ? error.message : String(error)})`,
        `Use pty_read to inspect the raw output instead.`,
        `</pty_screen>`,
      ].join('\n')
    }

    // Zero-padded so rows stay aligned and sortable in the reader's view, and so
    // a span's row can be matched against a body row by string equality.
    const rowWidth = String(rows).length
    const body = snapshot.lines.map(
      (line, index) => `${(index + 1).toString().padStart(rowWidth, '0')}| ${line}`
    )

    const attrs = [
      `id="${session.id}"`,
      `cols="${snapshot.cols}"`,
      `rows="${snapshot.rows}"`,
      `cursor="${snapshot.cursor.x},${snapshot.cursor.y}"`,
      `visible="${snapshot.cursor.visible}"`,
      `style="${snapshot.cursor.style}"`,
      `alternate="${snapshot.alternate}"`,
      `scrollback="${snapshot.scrollback}"`,
    ]
    if (fitted.clamped) {
      // The rendered geometry is not the requested one, and a reader comparing
      // the output against its expectations needs to know which it got.
      attrs.push(`requested="${requestedCols}x${requestedRows}"`)
    }
    if (snapshot.replayedChars < snapshot.totalChars) {
      // Stated in the attribute as well as the body: a partial replay is a
      // reconstruction, and a reader must not treat it as the whole session.
      attrs.push(`partial="${snapshot.replayedChars}/${snapshot.totalChars}"`)
    }

    const parts = [
      `<pty_screen ${attrs.join(' ')}>`,
      ...body,
      ...(args.colors === true && snapshot.spans.length > 0
        ? [
            '',
            `<pty_spans count="${snapshot.spans.length}">`,
            ...snapshot.spans.map((span) => describeSpan(span, rowWidth)),
            '</pty_spans>',
          ]
        : []),
    ]

    if (fitted.clamped) {
      parts.push(
        '',
        `(Rendered at ${cols}x${rows} instead of the requested ${requestedCols}x${requestedRows}: a screen that large costs too much to build. The layout below is the real layout, scaled.)`
      )
    }
    if (snapshot.replayedChars < snapshot.totalChars) {
      parts.push(
        '',
        `(Rendered from the last ${snapshot.replayedChars} of ${snapshot.totalChars} retained characters. Rows painted earlier and never touched again may be missing.)`
      )
    }
    if (body.every((line) => line.endsWith('| ')) && snapshot.totalChars === 0) {
      parts.push('', `(The session has produced no output yet.)`)
    }
    if (snapshot.alternate) {
      parts.push(
        '',
        `(The program is on the alternate screen, so this screen has no history. pty_read for the full stream.)`
      )
    }
    if (snapshot.scrollback > 0) {
      parts.push(
        '',
        `${snapshot.scrollback} line(s) of scrollback above this screen; read them with pty_read.`
      )
    }
    // A continued row is the tail of a line that did not fit, which is how wide
    // characters are handled. Saying so stops a reader treating the split as
    // truncation.
    if (snapshot.continuedRows.length > 0) {
      const continued = snapshot.continuedRows.map((row) => row + 1)
      const sources = snapshot.continuedRows.map((row) => row)
      parts.push(
        '',
        `(Row ${continued.join(', ')} continues row ${sources.join(', ')}: the line did not fit in ${snapshot.cols} columns, so it carries on below. Those rows are one line of output, not several.)`
      )
    }

    parts.push('</pty_screen>')
    return parts.join('\n')
  },
})
