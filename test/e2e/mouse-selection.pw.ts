import { expect, selectSession, test as extendedTest } from './fixtures'
import { waitForTerminalRegex } from './xterm-test-helpers.ts'

const mouseReader = [
  'import sys, tty',
  'tty.setraw(sys.stdin.fileno())',
  "sys.stdout.write('MOUSE_READY\\r\\n\\x1b[?1000h\\x1b[?1006h')",
  'sys.stdout.flush()',
  'value = sys.stdin.buffer.read(1)',
  "sys.stdout.write('\\r\\nMOUSE_HEX_' + value.hex() + '\\r\\n')",
  'sys.stdout.flush()',
].join(';')

extendedTest.describe('terminal mouse selection', () => {
  extendedTest('defers to applications after reset unless Shift is held', async ({ page, api }) => {
    await api.sessions.create({
      command: 'python3',
      args: ['-u', '-c', mouseReader],
      description: 'Mouse tracking selection',
    })
    await api.sessions.create({
      command: 'bash',
      args: ['-c', "printf 'OTHER SESSION\\n'; sleep 30"],
      description: 'Mouse tracking intermediary',
    })
    await selectSession(page, 'Mouse tracking selection')
    await page.waitForSelector('.terminal.xterm')
    await waitForTerminalRegex(page, /MOUSE_READY/)

    const staleInstanceMarked = await page.evaluate(() => {
      const terminal = window.xtermTerminal
      if (!terminal?.wasmTerm) return false
      terminal.wasmTerm.hasMouseTracking = () => false
      return true
    })
    expect(staleInstanceMarked).toBe(true)

    await selectSession(page, 'Mouse tracking intermediary')
    await waitForTerminalRegex(page, /OTHER SESSION/)
    await selectSession(page, 'Mouse tracking selection')
    await waitForTerminalRegex(page, /MOUSE_READY/)
    await page.waitForTimeout(100)

    const terminal = await page.locator('.terminal.xterm').boundingBox()
    if (!terminal) throw new Error('terminal is not visible')

    await page.mouse.click(terminal.x + 40, terminal.y + 30)
    await waitForTerminalRegex(page, /MOUSE_HEX_1b/)
    expect(await page.evaluate(() => window.xtermTerminal?.hasSelection() ?? false)).toBe(false)

    await page.keyboard.down('Shift')
    await page.mouse.move(terminal.x + 30, terminal.y + 8)
    await page.mouse.down()
    await page.mouse.move(terminal.x + 260, terminal.y + 52, { steps: 12 })
    await page.mouse.up()
    await page.keyboard.up('Shift')

    await expect
      .poll(() => page.evaluate(() => window.xtermTerminal?.hasSelection() ?? false))
      .toBe(true)
    expect(await page.evaluate(() => window.xtermTerminal?.getSelection() ?? '')).not.toBe('')
  })
})
