import type { Page } from '@playwright/test'

import type { createApiClient } from '../../src/web/shared/api-client.ts'
import { expect, test as extendedTest } from './fixtures'

const SESSION_DESCRIPTION = 'Settings test session'
const UI_PREFS_KEY = 'opencode-pty-ui-prefs'

/** Create a long-lived session and select it, waiting for the emulator. */
async function openSessionTerminal(
  page: Page,
  api: ReturnType<typeof createApiClient>
): Promise<void> {
  await api.sessions.create({
    command: 'bash',
    args: ['-i'],
    description: SESSION_DESCRIPTION,
  })

  const sessionItem = page.locator(`.session-item:has-text("${SESSION_DESCRIPTION}")`).first()
  await sessionItem.waitFor({ state: 'visible', timeout: 5000 })
  await sessionItem.click()
  await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
  await page.waitForFunction(() => window.xtermTerminal !== undefined, { timeout: 10000 })
}

/** Re-select the session after a reload and wait for the fresh emulator. */
async function reselectAfterReload(page: Page): Promise<void> {
  const sessionItem = page.locator(`.session-item:has-text("${SESSION_DESCRIPTION}")`).first()
  await sessionItem.waitFor({ state: 'visible', timeout: 5000 })
  await sessionItem.click()
  await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
  await page.waitForFunction(() => window.xtermTerminal !== undefined, { timeout: 10000 })
}

async function readStoredPrefs(
  page: Page
): Promise<{ terminalFontSize?: number; showDebugBar?: boolean }> {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : {}
  }, UI_PREFS_KEY)
}

const settingsButton = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true })
const dialog = (page: Page) => page.getByRole('dialog')

extendedTest.describe('settings modal', () => {
  extendedTest(
    'opens from the sidebar button and closes with ESC, returning focus',
    async ({ page }) => {
      const button = settingsButton(page)
      await button.click()

      await expect(dialog(page)).toBeVisible()
      await expect(dialog(page).getByRole('heading', { name: 'Settings' })).toBeVisible()
      // The background is inert while the modal is open.
      await expect(page.locator('.container')).toHaveAttribute('inert', '')

      await page.keyboard.press('Escape')

      await expect(dialog(page)).not.toBeVisible()
      await expect(page.locator('.container')).not.toHaveAttribute('inert', '')
      await expect(button).toBeFocused()
    }
  )

  extendedTest('opens with the Ctrl+, shortcut', async ({ page }) => {
    await page.keyboard.press('Control+,')
    await expect(dialog(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog(page)).not.toBeVisible()
  })

  extendedTest('reuses the theme preference from the sidebar', async ({ page }) => {
    await settingsButton(page).click()
    await dialog(page).getByRole('button', { name: 'Light', exact: true }).click()

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light')
    // The sidebar switch reflects the same preference, so the two stay in sync.
    await expect(page.locator('.sidebar .theme-switch-option[aria-pressed="true"]')).toHaveText(
      'Light'
    )

    await page.keyboard.press('Escape')
  })

  extendedTest(
    'changes the terminal font size live and persists it across reload',
    async ({ page, api }) => {
      await openSessionTerminal(page, api)

      await settingsButton(page).click()
      await dialog(page).getByLabel('Terminal font size').fill('20')

      await expect.poll(() => page.evaluate(() => window.xtermTerminal?.options.fontSize)).toBe(20)
      expect((await readStoredPrefs(page)).terminalFontSize).toBe(20)

      await page.keyboard.press('Escape')
      await page.reload()
      await reselectAfterReload(page)

      await expect.poll(() => page.evaluate(() => window.xtermTerminal?.options.fontSize)).toBe(20)
    }
  )

  extendedTest(
    'toggles the debug bar and persists the preference across reload',
    async ({ page, api }) => {
      await openSessionTerminal(page, api)
      await expect(page.locator('[data-testid="debug-info"]')).toHaveCount(1)

      await settingsButton(page).click()
      await dialog(page).getByLabel('Show debug bar').uncheck()
      await page.keyboard.press('Escape')

      await expect(page.locator('[data-testid="debug-info"]')).toHaveCount(0)
      expect((await readStoredPrefs(page)).showDebugBar).toBe(false)

      await page.reload()
      await reselectAfterReload(page)
      await expect(page.locator('.output-header')).toBeVisible()
      await expect(page.locator('[data-testid="debug-info"]')).toHaveCount(0)
    }
  )

  extendedTest('closes when the backdrop is clicked', async ({ page }) => {
    await settingsButton(page).click()
    await expect(dialog(page)).toBeVisible()

    // Click near the top-left corner, outside the centered panel.
    await page.mouse.click(5, 5)

    await expect(dialog(page)).not.toBeVisible()
  })
})
