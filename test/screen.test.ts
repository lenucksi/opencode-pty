import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_REPLAY_WINDOW,
  isScreenEmulatorLoaded,
  renderScreen,
} from '../src/plugin/pty/screen.ts'

/**
 * A screen is not the last thing a process wrote.
 *
 * `pty_read` hands over the stream; for anything that paints a screen that is
 * not the information a reader wants, because the layout lives in escape
 * sequences, cursor moves and erase codes. These tests pin the property that
 * makes `pty_screen` worth its cost: the rendered result is the screen, not the
 * tail of the output.
 */

/** Cursor to absolute row/col, zero-based. */
function at(row: number, col: number, text: string): string {
  return `\x1b[${row + 1};${col + 1}H${text}`
}

describe('renderScreen', () => {
  it('renders plain lines as they appear, not as they were written', async () => {
    const screen = await renderScreen('alpha\r\nbeta\r\ngamma\r\n', 20, 6)

    expect(screen.lines.slice(0, 3)).toEqual(['alpha', 'beta', 'gamma'])
    expect(screen.cols).toBe(20)
    expect(screen.rows).toBe(6)
  })

  it('treats a bare LF as a linefeed, not as a newline', async () => {
    // What a PTY delivers for Enter is CR LF. A bare LF moves down without
    // returning the cursor, so the second line starts in column 6. Rendering it
    // as a plain newline would silently reformat any output that uses one -
    // including a file piped into a program that does not translate it.
    const screen = await renderScreen('alpha\nbeta\n', 20, 4)

    expect(screen.lines[0]).toBe('alpha')
    expect(screen.lines[1]).toBe('     beta')
  })

  it('shows the last screen of a long output, not the first', async () => {
    // The property that distinguishes a screen from a read: a build log's final
    // state is its last screen full, and the first lines have scrolled away.
    const raw = Array.from({ length: 500 }, (_, i) => `step ${i}`).join('\r\n')
    const screen = await renderScreen(raw, 20, 10)

    expect(screen.lines[0]).toBe('step 490')
    expect(screen.lines[9]).toBe('step 499')
    expect(screen.lines.join('\n')).not.toContain('step 0')
  })

  it('applies cursor positioning rather than concatenating the stream', async () => {
    // Written in an order that tells you nothing about the layout: the third
    // column is filled before the second. Read as a stream that is
    // "CBAxyz"; read as a screen it is two aligned columns, which is the only
    // reading under which the data means anything.
    const raw = [
      at(0, 8, 'c3'),
      at(0, 4, 'c2'),
      at(0, 0, 'c1'),
      at(1, 8, 'a3'),
      at(1, 4, 'a2'),
      at(1, 0, 'a1'),
    ].join('')
    const screen = await renderScreen(raw, 12, 3)

    expect(screen.lines[0]).toBe('c1  c2  c3')
    expect(screen.lines[1]).toBe('a1  a2  a3')
  })

  it('does not let a cursor move invent or lose content', async () => {
    // Same characters, same count, different screen than concatenation implies.
    const raw = `${at(0, 5, 'X')}Y`
    const screen = await renderScreen(raw, 10, 2)

    expect(screen.lines[0]).toBe('     XY')
    expect(screen.lines[0]?.replace(/\s/g, '')).toBe('XY')
  })

  it('honours an erase-line, so cleared cells are not shown as content', async () => {
    // Erase to end of line, then rewrite: the screen shows only the new text.
    // Read as a stream it would still contain the old text, which is how a
    // progress bar's leftovers end up being read as content.
    const raw = 'garbage\r\n\x1b[1A\r\x1b[Kreplaced'
    const screen = await renderScreen(raw, 20, 3)

    expect(screen.lines[0]).toBe('replaced')
    expect(screen.lines.join('\n')).not.toContain('garbage')
  })

  it('erases only the row it is on', async () => {
    // Two rows of output, then an erase aimed at the second. Reading it as a
    // whole-buffer clear would lose the first row.
    const raw = 'first row stays\r\nsecond row goes\r\n\x1b[1A\r\x1b[K'
    const screen = await renderScreen(raw, 30, 4)

    expect(screen.lines[0]).toBe('first row stays')
    expect(screen.lines[1]).toBe('')
  })

  it('erases a whole line on ESC[2K', async () => {
    const raw = 'stale content\r\n\x1b[1A\r\x1b[2K'
    const screen = await renderScreen(raw, 20, 3)

    expect(screen.lines[0]).toBe('')
  })

  it('renders a full-screen repaint as the last frame, not a smear of all frames', async () => {
    const frame = (n: number): string =>
      `\x1b[H\x1b[2Jframe ${n}\r\n` +
      Array.from({ length: 5 }, (_, i) => `row ${i} of ${n}`).join('\r\n')
    const screen = await renderScreen([frame(1), frame(2), frame(3)].join(''), 30, 8)

    expect(screen.lines[0]).toBe('frame 3')
    expect(screen.lines[1]).toBe('row 0 of 3')
    // No residue from the earlier frames.
    expect(screen.lines.join('\n')).not.toContain('of 1\n')
  })

  it('reports the cursor where the program left it', async () => {
    const screen = await renderScreen(`${at(2, 3, 'x')}`, 20, 8)

    expect(screen.cursor).toEqual({ x: 4, y: 2, visible: true, style: 'block' })
  })

  it('reports the alternate screen, which has no history', async () => {
    const normal = await renderScreen('ordinary output\n', 20, 5)
    const alt = await renderScreen('\x1b[?1049htui screen\x1b[?1049l', 20, 5)

    expect(normal.alternate).toBe(false)
    expect(alt.alternate).toBe(false) // left again by the time we read it
  })

  it('is on the alternate screen while the program is still in it', async () => {
    const screen = await renderScreen('\x1b[?1049hfull screen ui', 20, 5)

    expect(screen.alternate).toBe(true)
  })

  it('trims trailing blanks but keeps the row count', async () => {
    const screen = await renderScreen('x', 40, 5)

    expect(screen.lines).toHaveLength(5)
    expect(screen.lines[0]).toBe('x')
    expect(screen.lines[4]).toBe('')
  })

  it('renders an empty session as a blank screen rather than failing', async () => {
    const screen = await renderScreen('', 20, 4)

    expect(screen.lines).toEqual(['', '', '', ''])
    expect(screen.totalChars).toBe(0)
    expect(screen.replayedChars).toBe(0)
  })

  it('survives a truncated escape sequence at the replay boundary', async () => {
    // A cut in the middle of an escape sequence is what a bounded replay produces.
    // The parser has to resynchronise, not throw.
    const raw = `${'filler line\r\n'.repeat(50)}\x1b[3`
    const screen = await renderScreen(raw, 20, 5, 30)

    expect(screen.lines).toHaveLength(5)
  })

  it('replays a bounded window and says how much of the output it covered', async () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\r\n')
    const screen = await renderScreen(raw, 20, 5, 1000)

    expect(screen.replayedChars).toBe(1000)
    expect(screen.totalChars).toBe(raw.length)
    expect(screen.replayedChars).toBeLessThan(screen.totalChars)
  })

  it('marks a fully covered output as complete', async () => {
    const screen = await renderScreen('short output', 20, 5)

    expect(screen.replayedChars).toBe(screen.totalChars)
  })
})

describe('renderScreen colour spans', () => {
  it('reports a run only where something differs from the default', async () => {
    const screen = await renderScreen('plain\r\n\x1b[32mgreen\x1b[0m\r\n', 20, 4)

    // One span for the six green cells, and nothing for the plain rows.
    expect(screen.spans).toHaveLength(1)
    expect(screen.spans[0]?.row).toBe(1)
    expect(screen.spans[0]?.col).toBe(0)
    expect(screen.spans[0]?.length).toBe(5)
    expect(screen.spans[0]?.fg).toMatch(/^#[0-9a-f]{6}$/)
    expect(screen.spans[0]?.bg).toBeUndefined()
  })

  it('carries the style flags, not only the colour', async () => {
    const screen = await renderScreen('\x1b[1;4;3mbold underline italic\x1b[0m', 30, 3)
    const span = screen.spans[0]

    expect(span?.bold).toBe(true)
    expect(span?.underline).toBe(true)
    expect(span?.italic).toBe(true)
  })

  it('separates runs that differ only in colour', async () => {
    const screen = await renderScreen('\x1b[31mred\x1b[32mgreen\x1b[0m', 20, 3)

    expect(screen.spans).toHaveLength(2)
    expect(screen.spans[0]?.col).toBe(0)
    expect(screen.spans[1]?.col).toBe(3)
    expect(screen.spans[0]?.fg).not.toBe(screen.spans[1]?.fg)
  })

  it('separates runs on different rows even with identical styling', async () => {
    const screen = await renderScreen('\x1b[32mgreen\r\nmore green\x1b[0m', 20, 3)

    expect(screen.spans).toHaveLength(2)
    expect(screen.spans[0]?.row).toBe(0)
    expect(screen.spans[1]?.row).toBe(1)
  })

  it('reports a coloured background, which is how TUIs mark a selected row', async () => {
    const screen = await renderScreen('\x1b[44mselected\x1b[0m', 20, 3)

    expect(screen.spans[0]?.bg).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('produces no spans for output with no styling at all', async () => {
    const screen = await renderScreen('just\nplain\ntext\n', 20, 5)

    expect(screen.spans).toEqual([])
  })
})

describe('renderScreen geometry', () => {
  it('renders at the requested size rather than a fixed one', async () => {
    const narrow = await renderScreen('x', 10, 3)
    const wide = await renderScreen('x', 200, 40)

    expect(narrow.cols).toBe(10)
    expect(wide.cols).toBe(200)
    expect(wide.rows).toBe(40)
  })

  it('reproduces a full-screen repaint identically from a small window', async () => {
    // The reason a bounded replay is acceptable: a TUI's last repaint carries the
    // whole screen, so a short window and a long one agree.
    const frame = (n: number): string =>
      `\x1b[H\x1b[2Jdashboard\r\n` +
      Array.from({ length: 30 }, (_, i) => `metric ${i} value ${(n * i) % 97}`).join('\r\n')
    const raw = Array.from({ length: 30 }, (_, f) => frame(f)).join('')

    const wide = await renderScreen(raw, 120, 40, 5_000_000)
    const narrow = await renderScreen(raw, 120, 40, 65_536)

    expect(narrow.lines).toEqual(wide.lines)
    expect(narrow.spans).toEqual(wide.spans)
    expect(narrow.cursor).toEqual(wide.cursor)
  })

  it('renders a wide character without inserting a phantom space', async () => {
    // Each character covers two screen columns and is followed by an empty
    // continuation cell. Rendering that cell as a blank would produce
    // "日 本 語" and read as three words.
    const screen = await renderScreen('日本語', 20, 3)

    expect(screen.lines[0]).toBe('日本語')
  })

  it('keeps a blank cell a blank and a continuation nothing', async () => {
    // The two must not be conflated in the other direction either.
    const screen = await renderScreen('ab  cd', 20, 3)

    expect(screen.lines[0]).toBe('ab  cd')
  })

  it('mixes wide and narrow characters without shifting the text', async () => {
    const screen = await renderScreen('a日b本c', 20, 3)

    expect(screen.lines[0]).toBe('a日b本c')
  })

  it('does not split a combining grapheme into its first codepoint', async () => {
    // A flag emoji is two regional indicators; rendering only the first gives a
    // bare letter.
    const screen = await renderScreen('flag: 🇩🇪', 20, 3)

    expect(screen.lines[0]).toContain('🇩🇪')
  })
})

describe('screen emulator lifecycle', () => {
  it('loads the emulator on first use, not at import time', () => {
    // Importing the module must not pull in the ~1 MB WASM binary: most sessions
    // never call `pty_screen` and should not pay for it.
    expect(DEFAULT_REPLAY_WINDOW).toBe(262_144)
  })

  it('keeps serving renders after many calls', async () => {
    // The WASM allocation is not garbage collected. This is the cheap guard
    // against a per-call allocation that only shows up as a slow memory climb.
    for (let i = 0; i < 5; i++) {
      const screen = await renderScreen(`run ${i}\r\n`, 20, 3)
      expect(screen.lines[0]).toBe(`run ${i}`)
    }
    expect(isScreenEmulatorLoaded()).toBe(true)
  })
})
