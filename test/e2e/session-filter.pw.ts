import type { Page } from '@playwright/test'

import { expect, test as extendedTest } from './fixtures'

/**
 * The filter answers two different questions from one field: "which parent
 * conversation is this?" and "which process is this?". Both must work, and the
 * section counters have to follow the filtered set instead of the total.
 *
 * Every session here is inert on purpose. An earlier draft used
 * `bun run build:prod` as a distinctive command line; that really ran, and its
 * `bun clean` deleted the `dist/` the worker-scoped test server was serving
 * from, which killed every test after the second one.
 */

const FILTER = '.session-search-input'

/** Long-lived and side-effect free. */
const IDLE = ['-c', 'sleep 30']

/**
 * Wait for the live subscription before creating sessions.
 *
 * A session created after the page loaded but before the WebSocket subscribed
 * is never pushed, so the sidebar would not learn about it. Waiting for the
 * connection indicator closes that window and makes the tests deterministic
 * instead of racing the handshake.
 */
async function waitForSubscription(page: Page) {
  await expect(page.locator('.connection-status.connected')).toBeVisible({ timeout: 15_000 })
}

extendedTest.describe('sidebar session filter', () => {
  extendedTest('filters by concrete PTY title while typing', async ({ page, api: client }) => {
    await waitForSubscription(page)
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'build' })
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'migrate' })
    await page.waitForSelector('.session-item')
    await expect(page.locator('.session-item')).toHaveCount(2)

    await page.locator(FILTER).fill('migrate')
    await expect(page.locator('.session-item')).toHaveCount(1)
    await expect(page.locator('.session-item').first()).toContainText('migrate')
  })

  extendedTest(
    'is case insensitive and matches the command line',
    async ({ page, api: client }) => {
      await waitForSubscription(page)
      // Distinct, inert command lines: "sleep 41" vs "sleep 42".
      await client.sessions.create({ command: 'sleep', args: ['41'], description: 'release' })
      await client.sessions.create({ command: 'sleep', args: ['42'], description: 'notes' })
      await page.waitForSelector('.session-item')
      await expect(page.locator('.session-item')).toHaveCount(2)

      await page.locator(FILTER).fill('SLEEP 42')
      await expect(page.locator('.session-item')).toHaveCount(1)
      await expect(page.locator('.session-item').first()).toContainText('notes')
    }
  )

  extendedTest(
    'matches the group title and keeps every child of that group',
    async ({ page, wsClient }) => {
      await waitForSubscription(page)
      wsClient.send({
        type: 'spawn',
        command: 'bash',
        args: IDLE,
        description: 'Alpha first',
        parentSessionId: 'ses_filter_alpha',
        parentAgent: 'build',
      })
      wsClient.send({
        type: 'spawn',
        command: 'bash',
        args: IDLE,
        description: 'Alpha second',
        parentSessionId: 'ses_filter_alpha',
        parentAgent: 'build',
      })
      wsClient.send({
        type: 'spawn',
        command: 'bash',
        args: IDLE,
        description: 'Unrelated',
        parentSessionId: 'ses_filter_beta',
        parentAgent: 'plan',
      })

      await page.waitForSelector('[data-testid="parent-session-group"]')
      await expect(page.locator('.session-item')).toHaveCount(3)

      // The group title falls back to the parent id, so search on that.
      await page.locator(FILTER).fill('ses_filter_alpha')
      await expect(page.locator('.session-item')).toHaveCount(2)
      await expect(page.locator('.session-item').filter({ hasText: 'Unrelated' })).toHaveCount(0)
    }
  )

  extendedTest('hides groups that match neither title nor child', async ({ page, wsClient }) => {
    await waitForSubscription(page)
    wsClient.send({
      type: 'spawn',
      command: 'bash',
      args: IDLE,
      description: 'Keepme',
      parentSessionId: 'ses_filter_keep',
    })
    wsClient.send({
      type: 'spawn',
      command: 'bash',
      args: IDLE,
      description: 'Dropme',
      parentSessionId: 'ses_filter_drop',
    })
    await page.waitForSelector('[data-testid="parent-session-group"]')

    await page.locator(FILTER).fill('Keepme')
    await expect(page.locator('.session-item')).toHaveCount(1)
    await expect(page.locator('.session-item').first()).toContainText('Keepme')
  })

  extendedTest(
    'shows its own empty state instead of "no active sessions"',
    async ({ page, api: client }) => {
      await waitForSubscription(page)
      await client.sessions.create({ command: 'bash', args: IDLE, description: 'build' })
      await page.waitForSelector('.session-item')

      await page.locator(FILTER).fill('definitely-not-present')
      const empty = page.locator('.session-empty')
      await expect(empty).toHaveCount(1)
      await expect(empty).toContainText(/no session matches/i)
      await expect(empty).not.toContainText('No active sessions')
    }
  )

  extendedTest('section counters follow the filtered set', async ({ page, api: client }) => {
    await waitForSubscription(page)
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'build' })
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'migrate' })
    await page.waitForSelector('.session-item')

    const runningCount = page.locator('.session-section-running .session-section-count')
    await expect(runningCount).toHaveText('2')

    // A partial match must lower the counter, not just hide rows.
    await page.locator(FILTER).fill('migrate')
    await expect(runningCount).toHaveText('1')

    await page.locator(FILTER).fill('')
    await expect(runningCount).toHaveText('2')
  })

  extendedTest('clears on Escape and restores the full list', async ({ page, api: client }) => {
    await waitForSubscription(page)
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'build' })
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'migrate' })
    await page.waitForSelector('.session-item')
    await expect(page.locator('.session-item')).toHaveCount(2)

    const filter = page.locator(FILTER)
    await filter.fill('migrate')
    await expect(page.locator('.session-item')).toHaveCount(1)

    await filter.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(page.locator('.session-item')).toHaveCount(2)
  })

  extendedTest('offers a clear button that restores the list', async ({ page, api: client }) => {
    await waitForSubscription(page)
    await client.sessions.create({ command: 'bash', args: IDLE, description: 'build' })
    await page.waitForSelector('.session-item')

    const filter = page.locator(FILTER)
    await filter.fill('migrate')
    await expect(filter).toHaveValue('migrate')

    // Only shown while a filter is active.
    const clear = page.locator('.session-search-clear')
    await expect(clear).toBeVisible()
    await clear.click()
    await expect(filter).toHaveValue('')
    await expect(page.locator('.session-item')).toHaveCount(1)
  })
})
