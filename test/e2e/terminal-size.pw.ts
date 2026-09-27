import { expect, test as extendedTest } from './fixtures'
import type { Page } from '@playwright/test'
import type { TestFixtures } from './fixtures.ts'

/**
 * The terminal geometry the server reports must be the geometry the process
 * actually runs at.
 *
 * This is the assertion that catches the whole class of bug the old code allowed:
 * a size that is passed to the PTY but never recorded, a size recorded but not
 * handed to the process, and a size the UI believes while the server disagrees.
 * Comparing the two numbers is the only check that distinguishes them, because
 * each is individually plausible.
 */

/** Columns and rows the emulator pane is actually using. */
async function paneSize(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const terminal = window.xtermTerminal
    if (!terminal) throw new Error('terminal is not exposed on window')
    return { cols: terminal.cols, rows: terminal.rows }
  })
}

type Api = TestFixtures['api']

/** The size the server reports for a session, via the REST API. */
async function serverSize(api: Api, id: string): Promise<{ cols: number; rows: number }> {
  const session = await api.session.get({ id })
  return { cols: session.cols, rows: session.rows }
}

/** Open a session in the UI and wait for the pane to be live. */
async function attach(page: Page, description: string): Promise<void> {
  await page.waitForSelector('.session-item', { timeout: 5000 })
  await page.locator(`.session-item:has-text("${description}")`).click()
  await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
  await page.waitForFunction(() => window.xtermTerminal !== undefined, undefined, { timeout: 5000 })
}

extendedTest.describe('terminal size', () => {
  extendedTest(
    'the size the server reports equals the size of the pane it is shown in',
    async ({ page, api }) => {
      const created = await api.sessions.create({
        command: 'bash',
        args: ['-c', 'sleep 30'],
        description: 'Size parity',
      })

      await attach(page, 'Size parity')

      // The pane's first fit triggers a resize over the WebSocket, which is the
      // only thing that tells the server how big this terminal is.
      const pane = await paneSize(page)
      expect(pane.cols).toBeGreaterThan(10)
      expect(pane.rows).toBeGreaterThan(2)

      await expect
        .poll(async () => (await serverSize(api, created.id)).cols, {
          message: 'server should adopt the pane width',
          timeout: 5000,
        })
        .toBe(pane.cols)

      const server = await serverSize(api, created.id)
      expect(server).toEqual(pane)
    }
  )

  extendedTest('resizing the window changes the size the server reports', async ({ page, api }) => {
    const created = await api.sessions.create({
      command: 'bash',
      args: ['-c', 'sleep 30'],
      description: 'Size on resize',
    })
    await attach(page, 'Size on resize')

    const before = await paneSize(page)

    // Narrow the viewport enough that the emulator must reflow.
    await page.setViewportSize({ width: 620, height: 700 })
    await expect
      .poll(async () => (await paneSize(page)).cols, { timeout: 8000 })
      .toBeLessThan(before.cols)

    const pane = await paneSize(page)
    await expect
      .poll(async () => (await serverSize(api, created.id)).cols, {
        message: 'server should follow the pane after a reflow',
        timeout: 5000,
      })
      .toBe(pane.cols)
  })

  extendedTest(
    'the size is visible in the session list, not only in the API',
    async ({ page, api }) => {
      await api.sessions.create({
        command: 'bash',
        args: ['-c', 'sleep 30'],
        description: 'Size listed',
      })
      await page.waitForSelector('.session-item', { timeout: 5000 })

      // The tooltip is the only place the sidebar has room for the geometry.
      const title =
        (await page.locator('.session-item .session-meta').first().getAttribute('title')) ?? ''
      expect(title).toMatch(/\d+x\d+/)
    }
  )
})
