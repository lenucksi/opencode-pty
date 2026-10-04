import { test as extendedTest, expect } from './fixtures'
import {
  getTerminalBufferLines,
  getTerminalPlainText,
  waitForTerminalRegex,
} from './xterm-test-helpers'

extendedTest.describe('Xterm Content Extraction', () => {
  extendedTest(
    'should compare SerializeAddon extraction vs Terminal API with interactive commands',
    async ({ page, api }) => {
      await page.waitForSelector('h1:has-text("PTY Sessions")')

      // Create interactive bash session
      await api.sessions.create({
        command: 'bash',
        args: ['-i'],
        description: 'Interactive command comparison test',
      })

      // Wait for session to appear and select it
      await page.waitForSelector('.session-item', { timeout: 5000 })
      await page.locator('.session-item:has-text("Interactive command comparison test")').click()
      await page.waitForSelector('.output-container', { timeout: 5000 })
      await page.waitForSelector('.xterm', { timeout: 5000 })

      // Wait for session to initialize
      await waitForTerminalRegex(page, /\$\s*$/)

      // Extract content via the canonical SerializeAddon extractor

      // Send interactive command
      await page.locator('.terminal.xterm').click()
      await page.keyboard.type('echo "Hello World"', { delay: 20 })
      await page.keyboard.press('Enter')

      // Wait for command execution
      await waitForTerminalRegex(page, /Hello World/)

      // Wait for the shell to be idle again. waitForTerminalRegex only watches
      // the serialize buffer, so it returns as soon as the output has got there
      // while the emulator buffer API can still be a chunk behind. The prompt
      // coming back is the command finishing; without it the two extractors are
      // compared mid-stream, which passes on an idle machine and fails when
      // the rest of the suite runs in parallel.
      await waitForTerminalRegex(page, /\$\s*$/)

      // Via the canonical SerializeAddon extractor, then via the emulator buffer.
      // Both have to agree on what is on screen.

      const serializeContent = await getTerminalPlainText(page)

      // Extract content via the emulator's Terminal buffer API
      const terminalContent = await getTerminalBufferLines(page)

      // Compare content (both extraction paths must agree on the visible content)
      const serializeJoined = serializeContent.join('\n')
      const terminalJoined = terminalContent.join('\n')
      expect(serializeJoined).toContain('echo "Hello World"')
      expect(serializeJoined).toContain('Hello World')
      expect(terminalJoined).toContain('echo "Hello World"')
      expect(terminalJoined).toContain('Hello World')

      // The two extractors may differ by a trailing prompt/newline only.
      expect(Math.abs(serializeContent.length - terminalContent.length)).toBeLessThan(2)
    }
  )
})
