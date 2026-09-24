import { expect, test as extendedTest } from './fixtures'

const GROUP = '[data-testid="parent-session-group"]'

extendedTest.describe('parent session groups', () => {
  extendedTest(
    'groups running and finished PTYs by their OpenCode session',
    async ({ page, wsClient }) => {
      const spawn = (
        parentSessionId: string,
        description: string,
        args: string[] = ['-c', 'sleep 30']
      ) => {
        wsClient.send({
          type: 'spawn',
          command: 'bash',
          args,
          description,
          parentSessionId,
          parentAgent: 'build',
        })
      }

      spawn('ses_alpha', 'Alpha first')
      spawn('ses_alpha', 'Alpha second')
      spawn('ses_beta', 'Beta only')

      const runningSection = page.locator('.session-section-running')
      const runningGroups = runningSection.locator(GROUP)
      await expect(runningGroups).toHaveCount(2)
      await expect(runningGroups.nth(0).locator('.parent-session-title')).toHaveText(
        'Parent session ses_beta'
      )
      await expect(runningGroups.nth(1).locator('.parent-session-title')).toHaveText(
        'Parent session ses_alpha'
      )
      await expect(runningGroups.nth(0)).toHaveAttribute('open', '')
      await expect(runningGroups.nth(1)).toHaveAttribute('open', '')
      await expect(runningGroups.nth(1).locator('.parent-session-meta')).toContainText('build')
      await expect(runningGroups.nth(1).locator('.parent-session-meta')).toContainText('ses_alpha')
      await expect(runningGroups.nth(1).locator('.parent-session-meta')).toContainText('2 sessions')
      await expect(runningGroups.nth(1).locator('.session-item')).toHaveCount(2)

      spawn('ses_gamma', 'Finished child', ['-c', 'exit 0'])
      const finishedSection = page.locator('.session-section-finished')
      const finishedGroup = finishedSection.locator(GROUP)
      await expect(finishedGroup).toHaveCount(1)
      await expect(finishedGroup.locator('.parent-session-title')).toHaveText(
        'Parent session ses_gamma'
      )
      await expect(finishedGroup).not.toHaveAttribute('open', '')

      await finishedGroup.locator('summary').click()
      await expect(finishedGroup).toHaveAttribute('open', '')
      await expect(finishedGroup.locator('.session-item')).toContainText('Finished child')

      page.once('dialog', (dialog) => dialog.accept())
      await page.getByRole('button', { name: 'Clear finished' }).click()
      await expect(finishedSection.locator(GROUP)).toHaveCount(0)
      await expect(runningSection.locator(GROUP)).toHaveCount(2)
    }
  )
})
