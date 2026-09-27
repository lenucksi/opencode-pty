import { expect, test as extendedTest } from './fixtures'

/**
 * The header used to clip its last theme option.
 *
 * `.sidebar-header-controls` was a single non-wrapping row: the theme switch had
 * `flex: 1` with `min-inline-size: 0`, so it shrank below the 137px its three
 * 12px labels need while the two buttons took the rest of the 267px the sidebar
 * offers. `.sidebar { overflow: hidden }` then cut "Dark" off mid-glyph.
 *
 * These tests assert the invariant that was violated - the switch must never be
 * narrower than its own content - at the default width and at a narrow one, so
 * a third button cannot silently reintroduce the bug.
 */

async function measureThemeSwitch(page: import('@playwright/test').Page) {
  return await page.locator('.sidebar-header-controls .theme-switch').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
}

extendedTest.describe('sidebar header controls', () => {
  extendedTest('never clips the theme switch at the default sidebar width', async ({ page }) => {
    await page.waitForSelector('.sidebar-header-controls .theme-switch')

    const switchMetrics = await measureThemeSwitch(page)
    expect(switchMetrics.clientWidth).toBeGreaterThan(0)
    expect(switchMetrics.scrollWidth).toBeLessThanOrEqual(switchMetrics.clientWidth)

    // Every option is fully inside the switch, not cut by the sidebar edge.
    // Scoped to the header: the settings dialog renders a second theme switch,
    // and a closed <dialog> is still in the DOM.
    const lastOption = page.locator('.sidebar-header-controls .theme-switch-option', {
      hasText: 'Dark',
    })
    await expect(lastOption).toBeVisible()
    const inside = await lastOption.evaluate((element) => {
      const option = element.getBoundingClientRect()
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect()
      if (!sidebar) return false
      return option.right <= sidebar.right + 0.5 && option.width > 0
    })
    expect(inside).toBe(true)
  })

  extendedTest('never clips the theme switch at a narrow sidebar', async ({ page }) => {
    // Resize the window rather than the viewport so the whole layout reflows.
    await page.setViewportSize({ width: 900, height: 800 })
    await page.waitForSelector('.sidebar-header-controls .theme-switch')

    const switchMetrics = await measureThemeSwitch(page)
    expect(switchMetrics.scrollWidth).toBeLessThanOrEqual(switchMetrics.clientWidth)
  })

  extendedTest('puts every control on its own row instead of overlapping', async ({ page }) => {
    await page.waitForSelector('.sidebar-header-controls .settings-btn')

    // Theme switch and the buttons must not share a vertical band, and the
    // buttons must not overlap each other horizontally.
    const boxes = await page.locator('.sidebar-header-controls > *').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          cls: node.className,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        }
      })
    )
    expect(boxes.length).toBeGreaterThanOrEqual(3)

    const switchBox = boxes.find((b) => b.cls.includes('theme-switch'))
    const buttons = boxes.filter((b) => b.cls.includes('settings-btn'))
    expect(switchBox).toBeDefined()
    expect(buttons.length).toBe(2)

    for (const button of buttons) {
      expect(button.top).toBeGreaterThanOrEqual((switchBox?.top ?? 0) + 1)
    }
    // The two buttons share the row without overlapping.
    const [first, second] = buttons
    if (!first || !second) throw new Error('expected two header buttons')
    expect(first.right).toBeLessThanOrEqual(second.left)
  })

  extendedTest('gives every header control a tooltip', async ({ page }) => {
    await page.waitForSelector('.sidebar-header-controls .settings-btn')

    const withoutTitle = await page
      .locator('.sidebar-header-controls button')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => !(node.getAttribute('title') ?? '').trim())
          .map((node) => node.textContent?.trim() ?? '')
      )
    expect(withoutTitle).toEqual([])
  })

  extendedTest(
    'keeps the tooltip on the docs and settings triggers descriptive',
    async ({ page }) => {
      const docs = page.locator('.settings-btn', { hasText: 'Docs' })
      const settings = page.locator('.settings-btn', { hasText: 'Settings' })
      await expect(docs).toHaveAttribute('title', /documentation/i)
      await expect(settings).toHaveAttribute('title', /settings/i)
    }
  )
})
