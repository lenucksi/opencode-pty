import { expect, test as extendedTest } from './fixtures'

/**
 * The toast, end to end.
 *
 * In production a notice comes from the plugin's server half - a slash command's
 * result, a roll of the daemon started in another surface - and reaches the page over
 * the WebSocket the page already holds. This server-under-test does not load that
 * half, so it announces the one thing it can cause itself: a session ending. The
 * test server only does that for a session whose description asks for it, so the
 * rest of the suite runs without a toast on screen.
 */

extendedTest.describe('notices', () => {
  extendedTest('a notice from the server appears as a toast', async ({ page, api }) => {
    await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })

    // The description is the marker the test server listens for; the command exits
    // at once, which is what it announces.
    await api.sessions.create({
      command: 'sh',
      args: ['-c', 'exit 0'],
      description: 'notice:e2e-toast',
    })

    const toast = page.getByTestId('toast')
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toContainText('e2e-toast ended')
  })

  extendedTest('a toast can be dismissed, and takes itself away', async ({ page, api }) => {
    await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })

    await api.sessions.create({
      command: 'sh',
      args: ['-c', 'exit 0'],
      description: 'notice:e2e-dismiss',
    })

    const toast = page.getByTestId('toast')
    await expect(toast).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Dismiss notification' }).first().click()
    await expect(toast).toHaveCount(0)
  })
})
