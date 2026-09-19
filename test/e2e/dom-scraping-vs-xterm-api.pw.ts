import { test as extendedTest, expect } from './fixtures'
import {
  getTerminalBufferLines,
  getTerminalPlainText,
  waitForTerminalRegex,
} from './xterm-test-helpers'

extendedTest.describe('Xterm Content Extraction', () => {
  extendedTest(
    'should validate SerializeAddon extraction against the Terminal buffer API',
    async ({ page, api }) => {
      await page.waitForSelector('h1:has-text("PTY Sessions")')

      // Create a session and run some commands to generate content
      await api.sessions.create({
        command: 'bash',
        args: ['-c', 'echo "Line 1" && echo "Line 2" && echo "Line 3"'],
        description: 'Content extraction validation test',
      })

      // Wait for session to appear and select it
      await page.waitForSelector('.session-item', { timeout: 5000 })
      await page.locator('.session-item:has-text("Content extraction validation test")').click()
      await page.waitForSelector('.output-container', { timeout: 5000 })
      await page.waitForSelector('.xterm', { timeout: 5000 })

      // Wait for the command to complete
      await waitForTerminalRegex(page, /Line 3/)

      // Extract content via the canonical SerializeAddon extractor (no DOM text
      // layer exists with ghostty-web's canvas renderer).
      const serializeContent = await getTerminalPlainText(page)

      // Extract content via the emulator's Terminal buffer API
      const terminalContent = await getTerminalBufferLines(page)

      // NOTE: Strict line-by-line equality between the two extractors is not enforced.
      // They may differ on padding, prompt, and blank lines due to trimming quirks.
      // For robust test coverage, instead assert BOTH methods contain the expected
      // command output as an ordered slice.

      function findSliceIndex(haystack: string[], needles: string[]): number {
        // Returns the index in haystack where an ordered slice matching needles starts, or -1
        outer: for (let i = 0; i <= haystack.length - needles.length; i++) {
          for (let j = 0; j < needles.length; j++) {
            const hay = haystack[i + j] ?? ''
            const needle = needles[j] ?? ''
            if (!hay.includes(needle)) {
              continue outer
            }
          }
          return i
        }
        return -1
      }

      const expectedLines = ['Line 1', 'Line 2', 'Line 3']
      const serializeIdx = findSliceIndex(serializeContent, expectedLines)
      const termIdx = findSliceIndex(terminalContent, expectedLines)
      expect(serializeIdx).not.toBe(-1) // SerializeAddon extraction contains output
      expect(termIdx).not.toBe(-1) // Terminal API extraction contains output

      // Optionally: Fail if the arrays are dramatically different in length (to catch regressions)
      expect(Math.abs(serializeContent.length - terminalContent.length)).toBeLessThan(8)
      expect(serializeContent.length).toBeGreaterThanOrEqual(3)
      expect(terminalContent.length).toBeGreaterThanOrEqual(3)

      // (No output if matching: ultra-silent)
    }
  )
})
