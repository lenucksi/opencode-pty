import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import type { BunRequest } from 'bun'
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from '../src/plugin/constants.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import * as ScreenModule from '../src/plugin/pty/screen.ts'
import { ptyScreen } from '../src/plugin/pty/tools/screen.ts'
import {
  getSessionScreen,
  type SessionScreenResponse,
} from '../src/web/server/handlers/session-screen.ts'
import { getPlainBuffer } from '../src/web/server/handlers/sessions.ts'
import { routes } from '../src/web/shared/routes.ts'

/**
 * `GET /api/sessions/:id/screen` answers "what does it look like?", which
 * `buffer/plain` cannot: it is the ANSI-stripped byte stream, so a full-screen
 * program's layout - which lives in the escape sequences - is gone and every
 * repaint is left as text on its own line.
 *
 * The route exists because the server already computes the screen for
 * `pty_screen`. So these tests hold three things at once: the screen is rendered
 * (not the transcript), the route and the tool agree on the geometry, and the
 * plain buffer is still the plain buffer.
 */

/** A tool call needs a context; the screen route ignores it entirely. */
const ctx = {
  sessionID: 'parent',
  messageID: 'msg',
  agent: 'agent',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  directory: '/tmp',
  worktree: '/tmp',
}

/** The tool returns a string in practice; this keeps the assertions honest about it. */
function toolText(result: unknown): string {
  if (typeof result === 'string') return result
  throw new Error(`unexpected tool result: ${JSON.stringify(result).slice(0, 200)}`)
}

/** `cols="40"`, as the tool's result tag reports it. */
function toolGeometry(result: string): { cols: number; rows: number } {
  const cols = /cols="(\d+)"/.exec(result)?.[1]
  const rows = /rows="(\d+)"/.exec(result)?.[1]
  if (cols === undefined || rows === undefined) {
    throw new Error(`no geometry in tool result: ${result.slice(0, 200)}`)
  }
  return { cols: Number(cols), rows: Number(rows) }
}

/** GET the route the way the server routes it, query string included. */
async function requestScreen(id: string, query = ''): Promise<Response> {
  return getSessionScreen({
    params: { id },
    url: `http://localhost${routes.session.screen.path.replace(':id', id)}${query}`,
  } as unknown as BunRequest<typeof routes.session.screen.path>)
}

async function requestBody(response: Response): Promise<SessionScreenResponse> {
  return (await response.json()) as SessionScreenResponse
}

describe('GET /api/sessions/:id/screen', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  function spawn(raw: string, cols?: number, rows?: number): string {
    const info = manager.spawn({
      command: 'sh',
      args: ['-c', `printf '%b' '${raw}'; sleep 5`],
      description: 'screen route probe',
      parentSessionId: 'screen-route-test',
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
    })
    spawned.push(info.id)
    return info.id
  }

  /** Wait until the session's retained output contains `needle`. */
  async function waitFor(id: string, needle: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = manager.getRawBuffer(id)?.raw ?? ''
      if (raw.includes(needle)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`session ${id} never produced ${JSON.stringify(needle)}`)
  }

  it('renders the screen rather than the byte stream', async () => {
    const id = spawn('first\\r\\nsecond\\r\\n', 40, 8)
    await waitFor(id, 'second')

    const response = await requestScreen(id)
    expect(response.status).toBe(200)

    const body = await requestBody(response)
    expect(body.id).toBe(id)
    expect(body.lines.slice(0, 2)).toEqual(['first', 'second'])
    expect(body.cols).toBe(40)
    expect(body.rows).toBe(8)
  })

  it('honours the cursor and emits no escape bytes', async () => {
    // The case the route exists for. `\e[3;7H` is an absolute cursor move: the
    // program paints "moved" seven columns into row 3. Read as a transcript the
    // output is two lines plus a run of literal escape bytes; read as a screen it
    // is one line, indented, at the row the cursor was sent to.
    const id = spawn('top\\r\\nsecond\\r\\n\\e[3;7Hmoved', 40, 12)
    await waitFor(id, 'moved')

    const body = await requestBody(await requestScreen(id))

    // Cursor positioning was honoured: the text sits where it was sent.
    expect(body.lines[2]).toBe('      moved')
    // And the cursor is reported where it ended up, not where the stream's last
    // line would suggest.
    expect(body.cursor).toEqual({ x: 11, y: 2, visible: true, style: 'block' })

    // No escape bytes survive. Checked over the whole serialized response, because
    // a stray ESC anywhere - in a line, in the cursor style - would be a
    // consumer's problem rather than this route's.
    const serialized = JSON.stringify(body)
    expect(serialized.includes('\u001b')).toBe(false)
    expect(serialized.includes('\\u001b')).toBe(false)
    for (const line of body.lines) {
      expect(Bun.stripANSI(line)).toBe(line)
    }
  })

  it('renders the cursor move differently from buffer/plain, which is why both exist', async () => {
    const id = spawn('top\\r\\nsecond\\r\\n\\e[3;7Hmoved', 40, 12)
    await waitFor(id, 'moved')

    const plain = await getPlainBuffer({
      params: { id },
    } as unknown as BunRequest<typeof routes.session.buffer.plain.path>)
    const plainBody = (await plain.json()) as { plain: string }
    const screen = await requestBody(await requestScreen(id))

    // buffer/plain still answers its own question - the bytes, stripped - and
    // strips the cursor move along with the colour codes, so the indentation is
    // simply not in there.
    expect(plainBody.plain).toContain('moved')
    expect(plainBody.plain.startsWith('moved')).toBe(false)
    expect(screen.lines[2]).toBe('      moved')
  })

  it('404s for a session nobody has ever seen', async () => {
    const response = await requestScreen('pty_no_such_session')
    expect(response.status).toBe(404)
    expect((await response.json()) as { error: string }).toEqual({
      error: 'Session not found',
    })
  })

  describe('geometry', () => {
    it("defaults to the session's own recorded size", async () => {
      const id = spawn('x', 100, 30)
      await waitFor(id, 'x')

      const body = await requestBody(await requestScreen(id))
      expect(body.cols).toBe(100)
      expect(body.rows).toBe(30)
      // Not clamped, so nothing to report as requested.
      expect(body.requested).toBeUndefined()
    })

    it('renders at ?cols/?rows without touching the session', async () => {
      const id = spawn('y', 40, 8)
      await waitFor(id, 'y')

      const body = await requestBody(await requestScreen(id, '?cols=12&rows=4'))

      expect(body.cols).toBe(12)
      expect(body.rows).toBe(4)
      // The session is still at its own size: rendering at another geometry is a
      // question about the output, not a resize request.
      expect(manager.get(id)?.cols).toBe(40)
      expect(manager.get(id)?.rows).toBe(8)
    })

    it("clamps a dimension to the tool's limits", async () => {
      const id = spawn('z', 40, 8)
      await waitFor(id, 'z')

      const high = await requestBody(
        await requestScreen(id, `?cols=${MAX_TERMINAL_COLS + 500}&rows=${MAX_TERMINAL_ROWS + 500}`)
      )
      expect(high.cols).toBeLessThanOrEqual(MAX_TERMINAL_COLS)
      expect(high.rows).toBeLessThanOrEqual(MAX_TERMINAL_ROWS)
      // The per-dimension limit held at 1000x1000, and the cell budget then
      // reduced that further - so the route says what was asked for, which is
      // 1000x1000 rather than the 1500 that arrived in the query string, exactly
      // as `pty_screen`'s `requested` attribute reports the clamped request.
      // The screen below is the real layout, scaled, and a caller needs to know.
      const requested = high.requested
      expect(requested).toEqual({ cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS })
      if (requested === undefined) throw new Error('the clamped render reported no request')
      expect(high.cols).toBeLessThan(requested.cols)
      expect(high.rows).toBeLessThan(requested.rows)
    })

    it('falls back to the session size for a value that is not a number', async () => {
      const id = spawn('w', 40, 8)
      await waitFor(id, 'w')

      for (const query of ['?cols=abc', '?cols=', '?rows=NaN', '?cols=Infinity']) {
        const body = await requestBody(await requestScreen(id, query))
        expect({ query, cols: body.cols, rows: body.rows }).toEqual({
          query,
          cols: 40,
          rows: 8,
        })
      }
    })

    it('agrees with pty_screen on the geometry, for every shape of request', async () => {
      // The route and the tool answer the same question, so they have to render
      // at the same geometry. This runs the real tool against the real route over
      // the same session - not a copy of the tool's constants - so the day either
      // one changes its default or its clamping, this fails instead of producing a
      // screen that differs from the tool's for no visible reason.
      //
      // `?cols`/`?rows` are the route's spelling of the tool's `width`/`height`,
      // so each case carries both. `null` means "not supplied", which is the case
      // that matters most: it is where the two defaults have to agree.
      const cases: {
        label: string
        query: string
        width: number | null
        height: number | null
        /** A geometry this large is reduced by the cell budget, which costs a render. */
        expensive?: boolean
      }[] = [
        { label: 'defaults', query: '', width: null, height: null },
        { label: 'both given', query: '?cols=60&rows=20', width: 60, height: 20 },
        { label: 'below the minimum', query: '?cols=1&rows=0', width: 1, height: 0 },
        {
          label: 'above the maximum',
          query: '?cols=1000&rows=1000',
          width: 1000,
          height: 1000,
          expensive: true,
        },
        { label: 'cols only', query: '?cols=55', width: 55, height: null },
      ]

      for (const cols of [40, 240] as const) {
        for (const rows of [8, 80] as const) {
          // One session per geometry, reused across the cases: the point is the
          // geometry resolution, and a fresh session per case would spend the
          // test's time spawning rather than comparing.
          const id = spawn('q', cols, rows)
          await waitFor(id, 'q')

          for (const { label, query, width, height, expensive } of cases) {
            // The clamped-down render is ~100k cells, twice per case. Once is
            // enough to prove the budget is applied identically on both sides.
            if (expensive === true && cols === 240) continue

            const route = await requestBody(await requestScreen(id, query))
            const tool = toolGeometry(
              toolText(
                await ptyScreen.execute(
                  {
                    id,
                    ...(width === null ? {} : { width }),
                    ...(height === null ? {} : { height }),
                  },
                  ctx
                )
              )
            )

            expect({
              session: `${cols}x${rows}`,
              label,
              route: `${route.cols}x${route.rows}`,
              tool: `${tool.cols}x${tool.rows}`,
            }).toEqual({
              session: `${cols}x${rows}`,
              label,
              route: `${tool.cols}x${tool.rows}`,
              tool: `${tool.cols}x${tool.rows}`,
            })
          }
        }
      }
    })
  })

  it('reports a failed render instead of an empty screen', async () => {
    // An empty screen is indistinguishable from a program that printed nothing.
    // The route cannot swallow the emulator's failure for a caller, so it has to
    // become a status code with the reason in it.
    const id = spawn('content', 40, 6)
    await waitFor(id, 'content')

    const failing = spyOn(ScreenModule, 'renderScreen').mockImplementation(() => {
      throw new Error('emulator refused the geometry')
    })
    try {
      const response = await requestScreen(id)
      expect(response.status).toBe(500)
      expect((await response.json()) as { error: string }).toEqual({
        error: 'The screen could not be rendered: emulator refused the geometry',
      })
    } finally {
      failing.mockRestore()
    }
  })
})

/**
 * The reader's measured gap: the emulator HOLDS scrollback (the web UI scrolled
 * through it) while `/screen` answered with the visible rows only, so a line printed
 * a moment ago left the panel's console for good. The history is opt-in: the tool and
 * the web's own rendering keep the plain screen.
 */
describe('GET /api/sessions/:id/screen with scrollback', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  function spawn(raw: string, cols: number, rows: number): string {
    const info = manager.spawn({
      command: 'sh',
      args: ['-c', `printf '%b' '${raw}'; sleep 5`],
      description: 'screen scrollback probe',
      parentSessionId: 'screen-scrollback-test',
      cols,
      rows,
    })
    spawned.push(info.id)
    return info.id
  }

  async function waitFor(id: string, needle: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = manager.getRawBuffer(id)?.raw ?? ''
      if (raw.includes(needle)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`session ${id} never produced needed output`)
  }

  it('prepends scrollback rows, oldest first, when asked', async () => {
    const lines = []
    for (let i = 1; i <= 40; i++) lines.push(`a${i}`)
    const id = spawn(lines.map((line) => `${line}\r\n`).join(''), 20, 6)
    await waitFor(id, 'a40')

    const body = await requestBody(await requestScreen(id, '?scrollback=50'))
    expect(body.historyRows).toBeGreaterThan(0)
    expect(body.lines.length).toBe((body.historyRows ?? 0) + 6)
    expect(body.lines[0]).toBe('a1')
    // The boundary is exact: everything before `historyRows` is history, from there on
    // the screen. Assert the boundary BEHAVIOUR (the screen starts with the row after
    // the newest history line), not a magic line number - the emulator counts its own
    // scroll cap, and the amout is what the response reports.
    const boundary = body.historyRows
    if (boundary === undefined) throw new Error('the response does not say where history ends')
    expect(body.lines[boundary]).not.toBe(body.lines[boundary - 1])
    expect(body.lines[boundary]?.startsWith('a3')).toBe(true)
  })

  it('keeps the plain screen when no scrollback is asked', async () => {
    const id = spawn('b1\r\nb2\r\nb3\r\nb4\r\nb5\r\nb6\r\nb7\r\nb8\r\nb9\r\nb10\r\n', 20, 5)
    await waitFor(id, 'b10')

    const plain = await requestBody(await requestScreen(id))
    expect(plain.historyRows).toBeUndefined()
    // Bounded by the screen height, with at most the cursor's fresh row spare.
    expect(plain.lines.length).toBeLessThanOrEqual(6)
    // The newest output is the newest content in the plain shape.
    expect(plain.lines.filter((line) => line.trim().length > 0).at(-1)).toBe('b10')
  })
})
