import type { Page } from '@playwright/test'

import type { createApiClient } from '../../src/web/shared/api-client.ts'
import { expect, test as extendedTest } from './fixtures'
import { waitForTerminalRegex } from './xterm-test-helpers.ts'

/**
 * Copying used to require a working canvas selection: the browser cannot select
 * text on a canvas, Ctrl+C sends SIGINT, and the emulator only reacted to Cmd+C.
 * These tests cover the app-level copy actions, which read the emulator buffer
 * (or the server transcript) directly and therefore also work when no mouse
 * selection can be made.
 */
extendedTest.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const EARLY_MARKER = 'START-MARKER-AAA'
const LATE_MARKER = 'END-MARKER-ZZZ'

async function openTranscriptSession(
  page: Page,
  api: ReturnType<typeof createApiClient>
): Promise<void> {
  await api.sessions.create({
    command: 'bash',
    args: [
      '-lc',
      `echo ${EARLY_MARKER}; for i in $(seq 1 80); do printf 'line-%03d\\n' "$i"; done; echo ${LATE_MARKER}`,
    ],
    description: 'Copy test session',
  })

  await page.waitForSelector('.session-item', { timeout: 5000 })
  await page.locator('.session-item:has-text("Copy test session")').first().click()
  await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
  await waitForTerminalRegex(page, new RegExp(LATE_MARKER))
}

async function readClipboard(page: Page): Promise<string> {
  return await page.evaluate(() => navigator.clipboard.readText())
}

async function clearClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText('__CLEARED__'))
}

async function clickCopy(page: Page, name: 'Copy' | 'Copy all'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
}

extendedTest.describe('terminal copy', () => {
  extendedTest(
    'copies what is on screen, and the whole transcript on demand',
    async ({ page, api }) => {
      await openTranscriptSession(page, api)

      await clearClipboard(page)
      await clickCopy(page, 'Copy')
      const screen = await readClipboard(page)

      expect(screen).not.toBe('__CLEARED__')
      expect(screen).toMatch(/line-\d{3}/)
      expect(screen).toContain(LATE_MARKER)
      // The first line scrolled out of the emulator's window long ago.
      expect(screen).not.toContain(EARLY_MARKER)

      await clearClipboard(page)
      await clickCopy(page, 'Copy all')
      await expect.poll(() => readClipboard(page)).toContain(EARLY_MARKER)
      const transcript = await readClipboard(page)

      expect(transcript).toContain(LATE_MARKER)
      expect(transcript).toMatch(/line-080/)
    }
  )

  extendedTest('reports how much was copied', async ({ page, api }) => {
    await openTranscriptSession(page, api)

    await clickCopy(page, 'Copy')

    const feedback = page.getByTestId('copy-feedback')
    await expect(feedback).toHaveAttribute('aria-live', 'polite')
    await expect.poll(() => feedback.textContent()).toMatch(/^Copied \d+ lines$/)
  })

  extendedTest('copies the selection instead of the whole screen', async ({ page, api }) => {
    await openTranscriptSession(page, api)

    await clearClipboard(page)
    await clickCopy(page, 'Copy')
    const screenLines = (await readClipboard(page)).split('\n').length

    const term = await page.locator('.terminal.xterm').boundingBox()
    if (!term) throw new Error('terminal is not visible')

    // Drag from the first visible row to the middle of the screen only.
    await page.mouse.move(term.x + 40, term.y + 8)
    await page.mouse.down()
    await page.mouse.move(term.x + 240, term.y + Math.round(term.height / 2), { steps: 12 })
    await page.mouse.up()

    await clearClipboard(page)
    await clickCopy(page, 'Copy')
    const selection = await readClipboard(page)

    // A real selection read from the live buffer: text, not the blank lines a
    // stale selection manager used to hand back.
    expect(selection).not.toBe('__CLEARED__')
    expect(selection).toMatch(/line-\d{3}/)
    expect(selection.split('\n').length).toBeGreaterThan(0)
    // Only part of the screen was selected.
    expect(selection.split('\n').length).toBeLessThan(screenLines)
    expect(selection).not.toContain(LATE_MARKER)
  })

  extendedTest('Ctrl+Shift+C copies the terminal', async ({ page, api }) => {
    await openTranscriptSession(page, api)

    await clearClipboard(page)
    await page.locator('.terminal.xterm').click()
    await page.keyboard.press('Control+Shift+KeyC')

    await expect.poll(() => readClipboard(page)).not.toBe('__CLEARED__')
    expect(await readClipboard(page)).toMatch(/line-\d{3}/)
  })
})
