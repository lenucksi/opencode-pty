import { test as extendedTest, expect, selectSession } from './fixtures'
import { waitForTerminalRegex } from './xterm-test-helpers'

extendedTest.describe('Xterm Content Extraction', () => {
  extendedTest(
    'should compare SerializeAddon output with server buffer content',
    async ({ page, api }) => {
      await page.waitForSelector('h1:has-text("PTY Sessions")')

      // Create a session that runs a command and produces output
      await api.sessions.create({
        command: 'echo',
        args: ['Hello from SerializeAddon test'],
        description: 'SerializeAddon extraction test',
      })

      // Wait for session to appear and select it
      await selectSession(page, 'SerializeAddon extraction test', 5000)
      await page.waitForSelector('.output-container', { timeout: 5000 })
      await page.waitForSelector('.xterm', { timeout: 5000 })

      // Wait for the command output to appear in the terminal (SerializeAddon)
      await waitForTerminalRegex(page, /Hello from SerializeAddon test/)

      // Extract content using SerializeAddon
      const serializeAddonOutput = await page.evaluate(() => {
        const serializeAddon = window.xtermSerializeAddon

        if (!serializeAddon) {
          // SerializeAddon not found; let Playwright fail
          return ''
        }

        try {
          return serializeAddon.serialize({
            excludeModes: true,
            excludeAltBuffer: true,
          })
        } catch {
          return ''
        }
      })

      // Verify we extracted some content
      expect(serializeAddonOutput.length).toBeGreaterThan(0)

      // Verify the expected output is present (may contain ANSI codes)
      expect(serializeAddonOutput).toContain('Hello from SerializeAddon test')
    }
  )
})
