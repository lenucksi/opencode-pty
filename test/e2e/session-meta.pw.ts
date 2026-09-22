import { expect, test as extendedTest } from './fixtures'

extendedTest.describe('session list metadata', () => {
  extendedTest('shows pid, command and timing, newest first', async ({ page, api }) => {
    await api.sessions.create({
      command: 'bash',
      args: ['-c', 'sleep 30'],
      description: 'Meta first',
    })
    await page.waitForSelector('.session-item', { timeout: 5000 })

    // A later start time makes the order deterministic.
    await page.waitForTimeout(1100)
    await api.sessions.create({
      command: 'bash',
      args: ['-c', 'sleep 30'],
      description: 'Meta second',
    })

    await expect.poll(() => page.locator('.session-item').count()).toBe(2)

    const titles = await page.locator('.session-item .session-title').allTextContents()
    expect(titles[0]).toContain('Meta second')
    expect(titles[1]).toContain('Meta first')

    const newest = page.locator('.session-item').first()
    const meta = (await newest.locator('.session-meta').textContent()) ?? ''
    expect(meta).toMatch(/PID \d+/)
    expect(meta).toContain('started')
    expect(meta).toContain('running')

    // The command is shown with its arguments; the full details live in the tooltip.
    const command = (await newest.locator('.session-command').textContent()) ?? ''
    expect(command).toContain('bash -c sleep 30')
    expect(await newest.locator('.session-command').getAttribute('title')).toContain('workdir:')

    // The terminal header repeats the details on a second line.
    await newest.click()
    await page.waitForSelector('.terminal.xterm', { timeout: 5000 })
    const subtitle = (await page.locator('.output-subtitle').textContent()) ?? ''
    expect(subtitle).toMatch(/PID \d+/)
    expect(subtitle).toContain('started')
    expect(subtitle).toContain('bash -c sleep 30')
    expect(subtitle).toContain('lines')
  })

  extendedTest('reports end time and duration once a session finished', async ({ page, api }) => {
    await api.sessions.create({
      command: 'bash',
      args: ['-c', 'echo done'],
      description: 'Meta finished',
    })

    await expect
      .poll(
        async () => (await page.locator('.session-item .session-meta').first().textContent()) ?? ''
      )
      .toContain('ended')
  })
})
