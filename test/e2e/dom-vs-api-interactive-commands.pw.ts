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

      // Send interactive command
      await page.locator('.terminal.xterm').click()
      await page.keyboard.type('echo "Hello World"', { delay: 20 })
      await page.keyboard.press('Enter')

      // Wait for command execution
      await waitForTerminalRegex(page, /Hello World/)

      // Extract content via the canonical SerializeAddon extractor
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
