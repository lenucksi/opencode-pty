import type { Page } from '@playwright/test'

import type { createApiClient } from '../../src/web/shared/api-client.ts'
import { expect, test as extendedTest } from './fixtures'

/**
 * The app follows `prefers-color-scheme` and can be pinned to light or dark.
 * `playwright.config.ts` pins dark for the rest of the suite, so these tests are
 * the ones that exercise light mode.
 */

interface ThemeState {
  attribute: string | null
  colorScheme: string
  bodyBackground: string
  paneBackground: string
  stored: string | null
  termBackground: string | undefined
  termForeground: string | undefined
  termAnsiBlack: string | undefined
}

async function readThemeState(page: Page): Promise<ThemeState> {
  return await page.evaluate(() => {
    const terminal = window.xtermTerminal
    const pane = document.querySelector('.output-container')
    return {
      attribute: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      paneBackground: pane ? getComputedStyle(pane).backgroundColor : '',
      stored: localStorage.getItem('opencode-pty-theme'),
      termBackground: terminal?.options.theme.background,
      termForeground: terminal?.options.theme.foreground,
      termAnsiBlack: terminal?.options.theme.black,
    }
  })
}

/** Create a session, select it and wait until the emulator is exposed. */
async function openTerminal(page: Page, api: ReturnType<typeof createApiClient>): Promise<void> {
  await api.sessions.create({
    command: 'bash',
    args: ['-i'],
    description: 'Theme test session',
  })

  await page.waitForSelector('.session-item', { timeout: 5000 })
  await page.locator('.session-item:has-text("Theme test session")').first().click()
  await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
  await page.waitForFunction(() => window.xtermTerminal !== undefined, { timeout: 10000 })
}

async function clickTheme(page: Page, label: 'Auto' | 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
}

extendedTest.describe('adaptive theme (system dark)', () => {
  extendedTest('renders the dark palette and hands it to the terminal', async ({ page, api }) => {
    await openTerminal(page, api)

    const state = await readThemeState(page)

    expect(state.attribute).toBe('dark')
    expect(state.colorScheme).toBe('dark')
    expect(state.bodyBackground).toBe('rgb(13, 17, 23)')
    // The pane frame and the canvas share one background, so no seam shows.
    expect(state.paneBackground).toBe('rgb(13, 17, 23)')
    expect(state.termBackground).toBe('#0d1117')
    expect(state.termForeground).toBe('#c9d1d9')
    // The ANSI palette is applied too, not just fg/bg: `black` used to fall back
    // to the fork default (#000000), which was invisible on this background.
    expect(state.termAnsiBlack).toBe('#6e7681')
    await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  extendedTest(
    'switches to light live, persists it and repaints the pane',
    async ({ page, api }) => {
      await openTerminal(page, api)
      const before = await readThemeState(page)

      await clickTheme(page, 'Light')

      await expect.poll(async () => (await readThemeState(page)).attribute).toBe('light')
      await expect.poll(async () => (await readThemeState(page)).termBackground).toBe('#ffffff')

      const after = await readThemeState(page)
      expect(after.colorScheme).toBe('light')
      expect(after.termForeground).toBe('#1f2328')
      expect(after.termAnsiBlack).toBe('#24292f')
      expect(after.stored).toBe('light')
      expect(after.paneBackground).toBe('rgb(255, 255, 255)')
      expect(after.paneBackground).not.toBe(before.paneBackground)

      // The preference is persisted, not just held in memory.
      await page.reload()
      await expect.poll(async () => (await readThemeState(page)).attribute).toBe('light')
      expect((await readThemeState(page)).stored).toBe('light')
    }
  )

  extendedTest('returns to the system scheme when auto is picked again', async ({ page, api }) => {
    await openTerminal(page, api)

    await clickTheme(page, 'Light')
    await expect.poll(async () => (await readThemeState(page)).attribute).toBe('light')

    await clickTheme(page, 'Auto')
    await expect.poll(async () => (await readThemeState(page)).attribute).toBe('dark')
    await expect.poll(async () => (await readThemeState(page)).termBackground).toBe('#0d1117')
    expect((await readThemeState(page)).stored).toBe('auto')
  })
})

extendedTest.describe('adaptive theme (system light)', () => {
  extendedTest.use({ colorScheme: 'light' })

  extendedTest('follows the OS while the preference is auto', async ({ page, api }) => {
    await openTerminal(page, api)

    const state = await readThemeState(page)

    expect(state.attribute).toBe('light')
    expect(state.colorScheme).toBe('light')
    expect(state.bodyBackground).toBe('rgb(255, 255, 255)')
    expect(state.termBackground).toBe('#ffffff')
    expect(state.termAnsiBlack).toBe('#24292f')
  })

  extendedTest(
    'lets an explicit dark preference win over the light system',
    async ({ page, api }) => {
      await openTerminal(page, api)

      await clickTheme(page, 'Dark')

      await expect.poll(async () => (await readThemeState(page)).attribute).toBe('dark')
      await expect.poll(async () => (await readThemeState(page)).termBackground).toBe('#0d1117')
      expect((await readThemeState(page)).stored).toBe('dark')
    }
  )
})
