import { expect, test as extendedTest } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The version and commit of the build that is actually running.
 *
 * The client bundle and the server can be from different builds, so the value is
 * fetched from `/api/server` rather than baked into the bundle. A test that only
 * checked the DOM would pass against a bundle showing a stale commit, which is
 * the failure this display exists to prevent.
 */

/** The Settings button is named by its text, not an aria-label. */
const settingsButton = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true })

extendedTest.describe('build identity', () => {
  extendedTest('shows the version and commit in settings', async ({ page, api }) => {
    await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })

    const server = await api.server()
    expect(server.build.version).toMatch(/^\d+\.\d+\.\d+/)

    await settingsButton(page).click()
    await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5000 })

    const value = page.locator('.settings-build-value')
    await expect(value).toBeVisible()
    await expect(value).toContainText(server.build.version)

    // The commit is the thing a bug report needs, so it has to be on screen and
    // not merely available somewhere.
    if (server.build.commit !== null) {
      await expect(value).toContainText(server.build.commit.slice(0, 7))
    }
  })

  extendedTest(
    'the value on screen is the server build, not the bundle build',
    async ({ page, api }) => {
      await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })
      const server = await api.server()

      await settingsButton(page).click()
      await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5000 })

      const shown = (await page.locator('.settings-build-value').textContent()) ?? ''
      // Exactly the server's value, no extra prose around it.
      expect(shown.trim()).toBe(`${server.build.version} (${server.build.commit})`)
    }
  )

  extendedTest(
    'confirms the copy next to the button, where the user is looking',
    async ({ page }) => {
      await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })
      await settingsButton(page).click()
      await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5000 })

      const confirm = page.locator('.settings-build-copied')
      await expect(confirm).toBeEmpty()

      await page.locator('.settings-build-value').click()

      // Inside the dialog, not in the terminal header behind it. Feedback the modal
      // hides is feedback the user never sees.
      await expect(confirm).toHaveText('Copied')
      await expect(page.locator('.settings-build-value')).toBeVisible()
    }
  )

  extendedTest('the section is labelled, not colour-coded', async ({ page }) => {
    await page.waitForSelector('.connection-status.connected', { timeout: 10_000 })
    await settingsButton(page).click()
    await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5000 })

    // Every other section has a visible label; this one has to match, or it reads
    // as a stray value.
    await expect(page.locator('.settings-section-build .settings-label')).toHaveText('Version')
  })
})
