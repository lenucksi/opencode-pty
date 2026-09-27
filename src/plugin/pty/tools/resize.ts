import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../constants.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './resize.txt'

/**
 * `pty_resize` — change a running session's terminal geometry.
 *
 * Reachability is the point. `manager.resize` existed and only the web UI called
 * it, so an agent running a full-screen program had no way to change the geometry
 * it was given: it could kill and respawn, or work around the problem in the
 * program's own flags. Neither is a resize.
 */
export const ptyResize = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    cols: tool.schema
      .number()
      .optional()
      .describe(
        `Terminal width in columns (${MIN_TERMINAL_COLS}-${MAX_TERMINAL_COLS}). Omit to keep the current width.`
      ),
    rows: tool.schema
      .number()
      .optional()
      .describe(
        `Terminal height in rows (${MIN_TERMINAL_ROWS}-${MAX_TERMINAL_ROWS}). Omit to keep the current height.`
      ),
  },
  async execute(args) {
    const before: PTYSessionInfo | null = manager.get(args.id)
    if (!before) {
      throw buildSessionNotFoundError(args.id)
    }

    if (args.cols === undefined && args.rows === undefined) {
      return [
        `<pty_resized id="${before.id}" status="${before.status}">`,
        `Nothing to do: pass cols and/or rows.`,
        `Current: ${before.cols}x${before.rows}`,
        `</pty_resized>`,
      ].join('\n')
    }

    if (!manager.resize(args.id, args.cols, args.rows)) {
      throw buildSessionNotFoundError(args.id)
    }

    // Re-read rather than echoing the request: clamping means the answer is not
    // necessarily what was asked for, and the point of reporting is to remove
    // the need to guess.
    const after = manager.get(args.id) ?? before
    const changed: string[] = []
    if (after.cols !== before.cols) changed.push(`width ${before.cols} -> ${after.cols}`)
    if (after.rows !== before.rows) changed.push(`height ${before.rows} -> ${after.rows}`)

    return [
      `<pty_resized id="${after.id}" status="${after.status}" cols="${after.cols}" rows="${after.rows}">`,
      changed.length > 0
        ? `Changed: ${changed.join(', ')}`
        : `Unchanged: already ${after.cols}x${after.rows}`,
      `Current: ${after.cols}x${after.rows}`,
      // A process that reads its size only at startup will not react to this, and
      // the difference is invisible in the output.
      ...(after.status === 'running'
        ? [
            `Note: a program that read its size at startup will not redraw at the new geometry. Respawn with cols/rows if it must.`,
          ]
        : []),
      `</pty_resized>`,
    ].join('\n')
  },
})
