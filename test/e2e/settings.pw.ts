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

async function readStoredPrefs(page: Page): Promise<{ terminalFontSize?: number }> {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : {}
  }, UI_PREFS_KEY)
}

// The archive policy, read off the server rather than from a string in the page. The point
// of the section is that a reader can see the caps that are actually in force; a hardcoded
// "200 / 14 days" would stop the moment someone configures an override, and nothing on
// screen would say so.
const retentionSection = (page: Page) => page.getByTestId('settings-retention')

const withRetention = async (
  page: Page
): Promise<{
  maxSessions: number
  maxAgeDays: number
  maxBytesPerSession: number
}> => {
  const section = retentionSection(page)
  await expect(section).toBeVisible()
  const text = (await section.textContent()) ?? ''
  const sessions = /keep at most (\d+) sessions/.exec(text)
  const days = /keep sessions for (\d+) days/.exec(text)
  const kilo = /rotate a session's log past (\d+) KB/.exec(text)
  return {
    maxSessions: Number(sessions?.[1]),
    maxAgeDays: Number(days?.[1]),
    maxBytesPerSession: Number(kilo?.[1]) * 1024,
  }
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

  // The bar at the bottom used to be a debug strip behind a toggle. It is the status
  // line now - which build is serving, which session is on screen - so it is always
  // there, and the thing worth testing is that it survives a reload.
  extendedTest(
    'keeps the status bar, and the build it names, across a reload',
    async ({ page, api }) => {
      await openSessionTerminal(page, api)

      const bar = page.locator('[data-testid="status-bar"]')
      await expect(bar).toHaveCount(1)
      await expect(page.locator('[data-testid="status-build"]')).not.toBeEmpty()

      await page.reload()
      await reselectAfterReload(page)
      await expect(bar).toHaveCount(1)
      await expect(page.locator('[data-testid="status-session"]')).not.toBeEmpty()
    }
  )

  extendedTest('closes when the backdrop is clicked', async ({ page }) => {
    await settingsButton(page).click()
    await expect(dialog(page)).toBeVisible()

    // Click near the top-left corner, outside the centered panel.
    await page.mouse.click(5, 5)

    await expect(dialog(page)).not.toBeVisible()
  })

  // The server already published the policy; nothing read it. A reader had no way to learn
  // the caps that govern how long their own logs survive without finding the plugin config,
  // which is the same gap that cost a session twice over in another conversation.
  extendedTest(
    'shows the archive policy the server reports, not a hardcoded copy',
    async ({ page, api }) => {
      const info = await api.server()
      await settingsButton(page).click()
      await expect(dialog(page)).toBeVisible()

      expect(await withRetention(page)).toEqual({
        maxSessions: info.persist.retention.maxSessions,
        maxAgeDays: info.persist.retention.maxAgeDays,
        maxBytesPerSession: info.persist.retention.maxBytesPerSession,
      })
    }
  )

  // The caps are plugin options, not viewer preferences, and the section says so. Without
  // this line a reader looks for an input field that does not exist and concludes the
  // setting is broken rather than elsewhere.
  extendedTest('says where the caps are set', async ({ page }) => {
    await settingsButton(page).click()
    await expect(dialog(page)).toBeVisible()
    await expect(retentionSection(page)).toContainText('retention')
    await expect(retentionSection(page)).toContainText('removes sessions immediately')
  })
})
