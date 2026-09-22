import { readFileSync } from 'node:fs'

import { expect, test as extendedTest } from './fixtures'

/**
 * A transcript has two audiences: people want readable text, tools (and colour
 * debugging) want every escape sequence. The download menu offers both.
 */
extendedTest.describe('session log download', () => {
  extendedTest(
    'offers readable text and raw output with control characters',
    async ({ page, api }) => {
      await api.sessions.create({
        command: 'bash',
        args: ['-c', "printf '\\033[31mred line\\033[0m\\nplain line\\n'; sleep 5"],
        description: 'Download test session',
      })

      await page.waitForSelector('.session-item', { timeout: 5000 })
      await page.locator('.session-item:has-text("Download test session")').first().click()
      await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
      // Let the coloured line reach the buffer.
      await page.waitForTimeout(700)

      const menu = page.locator('.download-menu')
      await menu.locator('summary').click()
      await expect(menu.locator('.download-menu-item')).toHaveCount(2)

      const [plain] = await Promise.all([
        page.waitForEvent('download'),
        menu.locator('a', { hasText: 'Text (.txt)' }).click(),
      ])
      expect(plain.suggestedFilename()).toMatch(/\.txt$/)
      const plainText = readFileSync((await plain.path()) as string, 'utf8')
      expect(plainText).toContain('red line')
      expect(plainText).toContain('plain line')
      expect(plainText).not.toContain('\u001b[')

      await menu.locator('summary').click()
      const [raw] = await Promise.all([
        page.waitForEvent('download'),
        menu.locator('a', { hasText: 'Raw with control characters' }).click(),
      ])
      expect(raw.suggestedFilename()).toMatch(/\.log$/)
      const rawText = readFileSync((await raw.path()) as string, 'utf8')
      expect(rawText).toContain('\u001b[31mred line')
    }
  )
})
