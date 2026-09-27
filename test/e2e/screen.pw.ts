import { expect, test as extendedTest } from './fixtures'
import { getTerminalPlainText } from './xterm-test-helpers'
import { renderScreen } from '../../src/plugin/pty/screen.ts'

/**
 * The screen an agent sees and the screen a human sees must be the same screen.
 *
 * The web UI renders with the same VT parser, so comparing the tool's output
 * against what the emulator pane shows closes the loop: if the two disagree,
 * either the tool is reconstructing something the emulator would not, or the
 * pane is not actually showing the session's output. Both are invisible to a
 * test that only checks the tool against itself.
 */

extendedTest.describe('pty_screen', () => {
  extendedTest(
    'renders the same rows the human sees in the terminal pane',
    async ({ page, api }) => {
      const created = await api.sessions.create({
        command: 'sh',
        args: ['-c', 'printf "SCREEN-ROW-1\\r\\nSCREEN-ROW-2\\r\\nSCREEN-ROW-3\\r\\n"; sleep 30'],
        description: 'Screen parity',
      })

      await page.waitForSelector('.session-item', { timeout: 5000 })
      await page.locator('.session-item:has-text("Screen parity")').click()
      await page.waitForSelector('.terminal.xterm', { timeout: 5000 })

      const raw = await api.session.buffer.raw({ id: created.id })
      const session = await api.session.get({ id: created.id })
      const screen = await renderScreen(raw.raw, session.cols, session.rows)

      // The same three rows, in the same order, as a human would read them.
      expect(screen.lines.slice(0, 3)).toEqual(['SCREEN-ROW-1', 'SCREEN-ROW-2', 'SCREEN-ROW-3'])

      // And the pane agrees, via the serialized view the UI itself uses.
      const shown = await getTerminalPlainText(page)
      expect(shown).toContain('SCREEN-ROW-1')
      expect(shown).toContain('SCREEN-ROW-3')
    }
  )

  extendedTest('renders a positioned table the way the pane lays it out', async ({ page, api }) => {
    // A grid written with cursor moves. As a stream it is a smear; as a screen
    // it is a table. This is the case pty_read cannot express.
    const script = [
      'printf "\\033[1;1Halpha\\033[1;7Hbeta\\033[1;13Hgamma\\r\\n"',
      'printf "\\033[2;1Hone\\033[2;7Htwo\\033[2;13Hthree\\r\\n"',
      'sleep 30',
    ].join('; ')
    const created = await api.sessions.create({
      command: 'sh',
      args: ['-c', script],
      description: 'Screen table',
    })

    await page.waitForSelector('.session-item', { timeout: 5000 })
    await page.locator('.session-item:has-text("Screen table")').click()
    await page.waitForSelector('.terminal.xterm', { timeout: 5000 })

    const raw = await api.session.buffer.raw({ id: created.id })
    const session = await api.session.get({ id: created.id })
    const screen = await renderScreen(raw.raw, session.cols, session.rows)

    // The columns were addressed as 1, 7 and 13, so they start at those indices
    // and the gaps between them are whatever the words leave over.
    expect(screen.lines[0]).toBe('alpha beta  gamma')
    expect(screen.lines[1]).toBe('one   two   three')

    // The columns really are aligned, which is the whole point.
    const colOf = (line: string, word: string): number => line.indexOf(word)
    expect(colOf(screen.lines[0] ?? '', 'alpha')).toBe(colOf(screen.lines[1] ?? '', 'one'))
    expect(colOf(screen.lines[0] ?? '', 'beta')).toBe(colOf(screen.lines[1] ?? '', 'two'))
  })

  extendedTest('reports the geometry the session is actually running at', async ({ page, api }) => {
    const created = await api.sessions.create({
      command: 'bash',
      args: ['-c', 'sleep 30'],
      description: 'Screen geometry',
    })
    await page.waitForSelector('.session-item', { timeout: 5000 })
    await page.locator('.session-item:has-text("Screen geometry")').click()
    await page.waitForSelector('.terminal.xterm', { timeout: 5000 })

    const session = await api.session.get({ id: created.id })
    const raw = await api.session.buffer.raw({ id: created.id })
    const screen = await renderScreen(raw.raw, session.cols, session.rows)

    expect(screen.cols).toBe(session.cols)
    expect(screen.rows).toBe(session.rows)
    // A fresh session renders as a blank screen of the right shape, not an error.
    expect(screen.lines).toHaveLength(session.rows)
  })
})
