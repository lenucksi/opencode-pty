import { expect, selectSession, test as extendedTest } from './fixtures'
import { getTerminalPlainText, waitForTerminalRegex } from './xterm-test-helpers.ts'

const colorQueryReader = String.raw`
import os, select, sys, time, tty

tty.setraw(sys.stdin.fileno())
query = b"\x1b]10;?;?\x1b\\"
for fragment in (query[:3], query[3:8], query[8:]):
    os.write(sys.stdout.fileno(), fragment)
    time.sleep(0.05)

received = bytearray()
deadline = time.time() + 3
while time.time() < deadline:
    readable, _, _ = select.select([sys.stdin.fileno()], [], [], 0.1)
    if readable:
        received.extend(os.read(sys.stdin.fileno(), 4096))
    if b"\x1b]10;rgb:" in received and b"\x1b]11;rgb:" in received:
        break

if b"\x1b]10;rgb:" in received and b"\x1b]11;rgb:" in received:
    status = b"COLOR_QUERY_OK"
else:
    status = b"COLOR_QUERY_FAIL:" + received.hex().encode()

sys.stdout.buffer.write(b"\r\n" + status + b"\r\n")
sys.stdout.flush()
time.sleep(30)
`

extendedTest.describe('terminal color queries', () => {
  extendedTest('answers a fragmented combined OSC 10/11 query', async ({ page, api }) => {
    await api.sessions.create({
      command: 'python3',
      args: ['-u', '-c', colorQueryReader],
      description: 'Fragmented color query',
    })
    await selectSession(page, 'Fragmented color query')
    await page.waitForSelector('.terminal.xterm')

    await waitForTerminalRegex(page, /COLOR_QUERY_(?:OK|FAIL)/)
    const output = (await getTerminalPlainText(page)).join('\n')
    expect(output).toContain('COLOR_QUERY_OK')
  })
})
