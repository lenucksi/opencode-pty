import { expect, test as extendedTest } from './fixtures'

const DOCS_BUTTON = 'button:has-text("Docs")'
const TAB_HUMANS = '#docs-tab-humans'
const TAB_LLM = '#docs-tab-llm'
const TAB_LICENSES = '#docs-tab-licenses'

/** The slice of `/api/licenses` this spec reads; the server owns the full type. */
interface LicensesPayload {
  available: boolean
  total: number
  groups: {
    license: string
    count: number
    packages: { name: string; version: string; license: string }[]
  }[]
}

extendedTest.describe('documentation dialog', () => {
  extendedTest('opens from the sidebar and shows the human sections', async ({ page }) => {
    await page.locator(DOCS_BUTTON).click()

    const dialog = page.locator('.docs-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.locator('.docs-title')).toHaveText('Documentation')

    await expect(page.locator(TAB_HUMANS)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.docs-section')).not.toHaveCount(0)

    // Every human section renders a heading and at least one line of content.
    const first = page.locator('.docs-section').first()
    await expect(first.locator('.docs-section-title')).not.toBeEmpty()
    await expect(first.locator('.docs-paragraph, .docs-list li').first()).not.toBeEmpty()

    // The long form lives on GitHub, not in the dialog.
    const readme = page.locator('.docs-footer a')
    await expect(readme).toHaveAttribute('href', /^https:\/\/github\.com\//)
    await expect(readme).toHaveAttribute('target', '_blank')
  })

  extendedTest('serves the agent the very same document the dialog shows', async ({ page }) => {
    await page.locator(DOCS_BUTTON).click()
    await page.locator(TAB_LLM).click()

    await expect(page.locator(TAB_LLM)).toHaveAttribute('aria-selected', 'true')
    const intro = page.locator('.docs-llm-intro')
    await expect(intro).toContainText('opencode-pty:pty-usage')

    // The rendered block is the skill itself, not a paraphrase.
    const shown = ((await page.locator('.docs-pre').textContent()) ?? '').trim()
    const expected = await page.evaluate(async () => {
      const response = await fetch('/api/docs')
      const payload = (await response.json()) as { llm: { content: string } }
      return payload.llm.content.trim()
    })
    expect(shown).toBe(expected)
    expect(shown).toContain('pty_wait')
  })

  extendedTest('covers third-party notices from the generated artifact', async ({ page }) => {
    await page.locator(DOCS_BUTTON).click()
    await page.locator(TAB_LICENSES).click()

    await expect(page.locator(TAB_LICENSES)).toHaveAttribute('aria-selected', 'true')
    const panel = page.locator('#docs-panel-licenses')
    await expect(panel).toBeVisible()

    // Credits are the only hand-written part of this tab.
    await expect(panel.locator('.docs-credit-list li')).toHaveCount(4)
    await expect(panel.locator('.docs-credit-list')).toContainText('ghostty-web')

    // The grouped list has to be what the server reports, not a copy that drifts.
    const payload = (await page.evaluate(async () => {
      const response = await fetch('/api/licenses')
      return response.json() as Promise<unknown>
    })) as LicensesPayload
    expect(payload.available).toBe(true)
    expect(payload.groups.length).toBeGreaterThan(3)
    await expect(panel.locator('.docs-paragraph').first()).toContainText(
      `${payload.total} installed packages`
    )

    for (const group of payload.groups) {
      const details = panel.locator(`.docs-license-group[data-license="${group.license}"]`)
      await expect(details).toHaveCount(1)
      await expect(details.locator('.docs-license-count')).toHaveText(
        `${group.count} ${group.count === 1 ? 'package' : 'packages'}`
      )
    }

    // A known package is the second half of the answer: which licence it is under.
    // The exact name@version comes from the API, never from a guess in this file.
    const packages = payload.groups.flatMap((group) => group.packages)
    for (const name of ['react', 'ghostty-web']) {
      const pkg = packages.find((entry) => entry.name === name)
      expect(pkg).toBeDefined()
      if (!pkg) continue
      const details = panel.locator(`.docs-license-group[data-license="${pkg.license}"]`)
      if ((await details.getAttribute('open')) === null) {
        await details.locator('summary').click()
      }
      // `exact` matters: `@types/react@…` also contains `react@…`.
      await expect(details.getByText(`${pkg.name}@${pkg.version}`, { exact: true })).toBeVisible()
    }
  })

  extendedTest('scrolls the human sections instead of clipping them', async ({ page }) => {
    await page.locator(DOCS_BUTTON).click()
    const body = page.locator('.docs-body')
    await expect(body).toBeVisible()

    // Clipping bug: a flex child without min-height:0 refuses to shrink, so the
    // content overflowed the dialog and the last section was cut off.
    const metrics = await body.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(metrics.overflowY).toBe('auto')
    expect(metrics.clientHeight).toBeGreaterThan(0)
    expect(metrics.scrollHeight).toBeGreaterThan(0)

    // The final section must be reachable, not cut off.
    const lastSection = page.locator('.docs-section').last()
    await lastSection.scrollIntoViewIfNeeded()
    const fullyVisible = await lastSection.evaluate((element) => {
      const container = element.closest('.docs-body')
      if (!container) return false
      const a = element.getBoundingClientRect()
      const b = container.getBoundingClientRect()
      return a.bottom <= b.bottom + 1
    })
    expect(fullyVisible).toBe(true)
  })

  extendedTest('closes with Escape and returns focus to the trigger', async ({ page }) => {
    const trigger = page.locator(DOCS_BUTTON)
    await trigger.click()
    await expect(page.locator('.docs-dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.docs-dialog')).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  extendedTest('keeps the app shell inert while open', async ({ page }) => {
    await page.locator(DOCS_BUTTON).click()
    await expect(page.locator('.docs-dialog')).toBeVisible()
    await expect(page.locator('.container')).toHaveAttribute('inert', '')
    await page.locator('.docs-close').click()
    await expect(page.locator('.docs-dialog')).toBeHidden()
    await expect(page.locator('.container')).not.toHaveAttribute('inert', '')
  })
})
