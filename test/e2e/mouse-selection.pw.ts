import { expect, selectSession, test as extendedTest } from './fixtures'
import { waitForTerminalRegex } from './xterm-test-helpers.ts'

extendedTest.describe('terminal mouse selection', () => {
  extendedTest(
    'defers to applications with mouse tracking unless Shift is held',
    async ({ page, api }) => {
      const marker = 'MOUSE-TRACKING-SELECTION'
      const session = await api.sessions.create({
        command: 'bash',
        args: [],
        description: 'Mouse tracking selection',
      })
      await selectSession(page, 'Mouse tracking selection')
      await page.waitForSelector('.terminal.xterm')

      await api.session.input(
        { id: session.id },
        { data: `printf '${marker}\\r\\n\\033[?1000h\\033[?1002h'\r` }
      )
      await waitForTerminalRegex(page, new RegExp(marker))
      await page.waitForTimeout(100)

      const terminal = await page.locator('.terminal.xterm').boundingBox()
      if (!terminal) throw new Error('terminal is not visible')

      const drag = async (holdShift: boolean) => {
        if (holdShift) await page.keyboard.down('Shift')
        await page.mouse.move(terminal.x + 30, terminal.y + 8)
        await page.mouse.down()
        await page.mouse.move(terminal.x + 260, terminal.y + 52, { steps: 12 })
        await page.mouse.up()
        if (holdShift) await page.keyboard.up('Shift')
      }

      await drag(false)
      expect(await page.evaluate(() => window.xtermTerminal?.hasSelection() ?? false)).toBe(false)

      await drag(true)
      await expect
        .poll(() => page.evaluate(() => window.xtermTerminal?.hasSelection() ?? false))
        .toBe(true)
      expect(await page.evaluate(() => window.xtermTerminal?.getSelection() ?? '')).not.toBe('')
    }
  )
})
