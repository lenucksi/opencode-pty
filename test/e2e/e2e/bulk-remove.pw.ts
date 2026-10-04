import { expect } from '@playwright/test'

import { test as extendedTest, revealSession } from '../fixtures'
import type { createApiClient } from '../../../src/web/shared/api-client'

/** The api client the fixture hands out, by its own type rather than a guess. */
type Api = ReturnType<typeof createApiClient>

/**
 * Removing many sessions from the web UI.
 *
 * Two numbers have to be on screen before anything happens: how many go to the
 * trash and how many processes get stopped. A count on its own does not say that,
 * and the second one cannot be taken back - a stopped session keeps its record but
 * not its output.
 *
 * Sessions are created inside each test, never in a hook: one created before the
 * page's WebSocket subscribes is never pushed to the client, and the sidebar would
 * legitimately not know about it.
 */

const FINISHED = 'e2e-finished'

/** A session that has already exited, so it sits in the Finished group. */
async function spawnFinished(api: Api, tag: string) {
  return api.sessions.create({
    command: 'echo',
    args: [`${tag}-done`],
    description: `${FINISHED}-${tag}`,
  })
}

extendedTest.describe('bulk removal', () => {
  extendedTest('names the consequence before it happens, and undoes it', async ({ page, api }) => {
    await spawnFinished(api, 'one')
    await spawnFinished(api, 'two')
    await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })

    await page.locator('.clear-finished-btn').click()

    const dialog = page.getByTestId('remove-sessions-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Remove 2 sessions?')
    // The wording that makes the difference between the two kinds visible.
    await expect(dialog).toContainText('can be restored until the server restarts')

    await page.getByTestId('remove-dialog-confirm').click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.session-item')).toHaveCount(0)

    const toast = page.getByTestId('undo-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Removed 2 sessions')

    await page.getByTestId('undo-toast-action').click()
    await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })
  })

  extendedTest('cancelling removes nothing', async ({ page, api }) => {
    await spawnFinished(api, 'keep')
    await expect(page.locator('.session-item')).toHaveCount(1, { timeout: 10_000 })

    await page.locator('.clear-finished-btn').click()
    await expect(page.getByTestId('remove-sessions-dialog')).toBeVisible()
    await page.locator('.remove-dialog-cancel').click()

    await expect(page.getByTestId('remove-sessions-dialog')).not.toBeVisible()
    await expect(page.locator('.session-item')).toHaveCount(1)
    await expect(page.getByTestId('undo-toast')).not.toBeVisible()
  })

  extendedTest('a running session is announced as stopped, not removed', async ({ page, api }) => {
    await spawnFinished(api, 'mixed')
    const running = await api.sessions.create({
      command: 'sleep',
      args: ['41'],
      description: 'e2e-running',
    })
    await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })

    // Selection mode exists so a running session can be picked on purpose; the
    // one-click action deliberately only ever touches finished ones.
    await page.getByTestId('selection-enter').click()
    await revealSession(page, 'e2e-running')
    await page.getByTestId(`session-select-${running.id}`).check()

    await page.getByTestId('selection-remove').click()

    const dialog = page.getByTestId('remove-sessions-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('1 running session will be stopped')
    await expect(dialog).toContainText('cannot be restored')
    // The button says what it will do, which is why its label changes.
    await expect(page.getByTestId('remove-dialog-confirm')).toContainText('Stop and remove')

    await page.getByTestId('remove-dialog-confirm').click()

    // The toast still appears: a process was stopped and the row vanished, and
    // silence would leave the reader unsure whether the click landed. What is
    // missing is the Undo button, because a stopped session keeps its record and
    // loses its output - offering Undo would restore an empty row.
    const stoppedToast = page.getByTestId('undo-toast')
    await expect(stoppedToast).toBeVisible()
    await expect(stoppedToast).toContainText('No output could be kept')
    await expect(page.getByTestId('undo-toast-action')).not.toBeVisible()
  })

  extendedTest(
    'a selection survives the search that hides part of it, and says so',
    async ({ page, api }) => {
      await spawnFinished(api, 'alpha')
      await spawnFinished(api, 'beta')
      await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })

      await page.getByTestId('selection-enter').click()
      // Finished groups start collapsed and a checkbox inside one is not
      // clickable, the same reason the session cards need `revealSession`.
      await revealSession(page, `${FINISHED}-alpha`)
      await revealSession(page, `${FINISHED}-beta`)
      await page.locator('.session-select').first().check()
      await page.locator('.session-select').nth(1).check()
      await expect(page.getByTestId('selection-count')).toContainText('2 selected')

      // Narrow the list to the one picked session, so the other is hidden while
      // still selected. Matching on a shared prefix would hide nothing, which is
      // why the query is the distinguishing word and not the first characters of
      // the row.
      await page.locator('.session-search-input').fill('alpha')
      await expect(page.locator('.session-item')).toHaveCount(1)

      const hidden = page.getByTestId('selection-hidden')
      await expect(hidden).toBeVisible()
      await expect(hidden).toContainText('hidden by search')

      await page.getByTestId('selection-remove').click()
      const dialog = page.getByTestId('remove-sessions-dialog')
      await expect(page.getByTestId('remove-dialog-hidden')).toBeVisible()
      await expect(dialog).toContainText('will be removed anyway')
    }
  )

  extendedTest(
    'select all visible, then leave selection mode with Escape',
    async ({ page, api }) => {
      await spawnFinished(api, 'one')
      await spawnFinished(api, 'two')
      await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })

      await page.getByTestId('selection-enter').click()
      await page.getByTestId('selection-select-visible').click()
      await expect(page.getByTestId('selection-count')).toContainText('2 selected')

      await page.keyboard.press('Escape')

      await expect(page.getByTestId('selection-toolbar')).not.toBeVisible()
      // Leaving selection mode clears the picks: coming back in must not reveal a
      // selection the reader has not seen since.
      await page.getByTestId('selection-enter').click()
      await expect(page.getByTestId('selection-count')).toContainText('0 selected')
    }
  )

  extendedTest(
    'a group checkbox selects the whole group and reports a partial state',
    async ({ page, api }) => {
      await spawnFinished(api, 'grp')
      await spawnFinished(api, 'grp')
      await expect(page.locator('.session-item')).toHaveCount(2, { timeout: 10_000 })

      await page.getByTestId('selection-enter').click()
      // Finished groups start collapsed and a checkbox inside one is not
      // clickable, the same reason the session cards need `revealSession`.
      await revealSession(page, `${FINISHED}-grp`)
      const groupCheckbox = page.locator('.session-group-select').first()
      await groupCheckbox.waitFor({ state: 'visible' })

      await groupCheckbox.check()
      await expect(page.getByTestId('selection-count')).toContainText('2 selected')
      await expect(groupCheckbox).toBeChecked()

      // Half the group: the control must say "some", not "none" and not "all".
      await page.locator('.session-select').first().uncheck()
      await expect(page.getByTestId('selection-count')).toContainText('1 selected')
      await expect(groupCheckbox).not.toBeChecked()
      expect(await groupCheckbox.evaluate((node: HTMLInputElement) => node.indeterminate)).toBe(
        true
      )
    }
  )
})
