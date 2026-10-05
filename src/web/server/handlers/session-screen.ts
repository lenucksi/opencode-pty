import type { BunRequest } from 'bun'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../../plugin/constants.ts'
import { manager } from '../../../plugin/pty/manager.ts'
import { fitScreenSize, renderScreen, type ScreenSnapshot } from '../../../plugin/pty/screen.ts'
import type { routes } from '../../shared/routes.ts'
import { ErrorResponse, JsonResponse } from './responses.ts'

/**
 * `GET /api/sessions/:id/screen` - what a session looks like, not what it wrote.
 *
 * The web UI reconstructs the screen on the client from the raw buffer, because it
 * ships the ghostty renderer. A TUI plugin has no DOM and no renderer of its own,
 * so the only way it can read a full-screen program's output as a screen is for
 * the server to do the replay. `pty_screen` already does exactly that for the
 * model; this is the same computation over HTTP.
 *
 * A separate route rather than a mode of `buffer/plain`, because the two answer
 * different questions and want different defaults. `buffer/plain` is the answer
 * to "what bytes did the program write" - it is the ANSI-stripped raw buffer, it
 * is cheap, and `pty_read` and its tests depend on it exactly as it is. Cursor
 * positioning is gone from it by definition, which is what makes a full-screen
 * program's output read as noise: every repaint and colour change stays as text
 * on its own line.
 */

/**
 * The rendered screen, plus what was asked for.
 *
 * `requested` is absent when the render honoured the request, and present when it
 * did not - either because a dimension was clamped to its limit or because the
 * cell budget shrank it. A caller comparing the screen against what it expected
 * needs to know which of the two it got, and `pty_screen` states it for the same
 * reason.
 */
export interface SessionScreenResponse extends ScreenSnapshot {
  id: string
  requested?: { cols: number; rows: number }
}

/**
 * One requested dimension, clamped the way `pty_screen` clamps it.
 *
 * This is `clampDimension` from `src/plugin/pty/tools/screen.ts`, which is
 * module-private there and cannot be imported from here without changing the
 * tool. The two must not drift: the route and the tool answer the same question,
 * so a session rendered at one geometry by one and a different geometry by the
 * other would be a bug in one of them that looks like a rendering bug in neither.
 * `test/web-screen-route.test.ts` runs the real tool and this real route over the
 * same sessions and asserts the geometries agree, so a divergence fails there
 * rather than in a rendering somebody has to debug from a screenshot.
 *
 * A value that is not a finite number falls back rather than becoming `NaN`
 * geometry, which the emulator would either reject or accept as a zero-width
 * terminal.
 */
function clampDimension(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/**
 * Render a session's retained output as the screen it currently paints.
 *
 * Geometry resolution is the tool's, in the tool's order: the session's own size
 * by default, each requested dimension clamped on its own, then a cell budget,
 * because a 1000x1000 screen is inside both limits and still a 25-second render.
 */
export async function getSessionScreen(
  req: BunRequest<typeof routes.session.screen.path>
): Promise<Response> {
  // The session first, because its recorded geometry is the default. Recorded at
  // spawn and updated by every resize, so this is the size the program was
  // actually given, not a size re-derived from whatever a client last mentioned.
  const session = manager.get(req.params.id)
  const bufferData = manager.getRawBuffer(req.params.id)
  // The same 404 as `getPlainBuffer`: no session, or no retained output for it.
  // A missing transcript is not a 200 with an empty screen - that reads as "the
  // program printed nothing", which is the opposite of the truth.
  if (!session || !bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  const url = new URL(req.url)
  const requestedCols = clampDimension(
    url.searchParams.get('cols'),
    MIN_TERMINAL_COLS,
    MAX_TERMINAL_COLS,
    session.cols
  )
  const requestedRows = clampDimension(
    url.searchParams.get('rows'),
    MIN_TERMINAL_ROWS,
    MAX_TERMINAL_ROWS,
    session.rows
  )
  const fitted = fitScreenSize(requestedCols, requestedRows)

  let snapshot: ScreenSnapshot
  try {
    snapshot = await renderScreen(bufferData.raw, fitted.cols, fitted.rows)
  } catch (error) {
    // The reason is in the response because the alternative is worse: an empty
    // screen is indistinguishable from a program that has printed nothing.
    return new ErrorResponse(
      `The screen could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
      500
    )
  }

  const body: SessionScreenResponse = { id: session.id, ...snapshot }
  if (fitted.clamped) {
    body.requested = { cols: requestedCols, rows: requestedRows }
  }
  return new JsonResponse(body)
}
