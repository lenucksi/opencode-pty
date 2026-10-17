import { afterEach, describe, expect, it } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'

/**
 * Byte-fidelity conformance for the PTY line discipline.
 *
 * The bug that motivated this file: a libvirt serial console (`virsh console`)
 * showed the boot menu and relayed arrow keys, but Enter did nothing. The
 * command was right, the bytes were written, and the program never saw them.
 *
 * The cause is not in this plugin. `pty_write` hands `\r` (0x0D) straight to
 * bun-pty, which writes it to the PTY master. The kernel's line discipline on
 * the slave then applies ICRNL - the default "cooked" mode - and delivers 0x0A
 * to the program instead. GRUB reads `\r` for Enter and ignores `\n`, so the
 * keystroke vanished. Arrow keys are escape sequences and are not translated,
 * which is why "cursor keys work, Enter doesn't".
 *
 * A PTY session can be asked for a raw line discipline (`raw: true`), which
 * turns ICRNL, ICANON, ISIG and ECHO off, so bytes arrive verbatim. These tests
 * pin both behaviours with real PTYs, because the failure was invisible at every
 * layer above the kernel: no error, a live session, and correct-looking output.
 *
 * The programs read exactly one byte and print it as hex behind a marker, so the
 * assertion is on what the program received rather than on what was echoed back
 * (cooked mode echoes the input, which would make a bare byte ambiguous).
 */

const BYTE_MARKER = 'PTYCONF'
const READY = 'PTYCONF-READY'

/**
 * `sh -c` body: announce readiness, then read one byte and print `PTYCONF:<hex>`.
 *
 * `dd bs=1 count=1` reads a single byte; `od -An -tx1` renders it as hex with no
 * address column; `tr` strips spaces and newlines. POSIX tools only, so the
 * suite does not depend on python.
 *
 * The readiness marker is not decoration. `raw: true` runs `stty raw` in a
 * wrapper shell *before* `exec`ing the real command, so a byte written in the
 * fork/exec window is still subject to the cooked discipline. Waiting for the
 * marker makes the test deterministic - and it mirrors the real workflow, where
 * you read the boot menu before you press Enter.
 */
const readOneByte = `printf '${READY}\\n'; b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '${BYTE_MARKER}:%s\\n' "$b"`

/** Same readiness handshake for a command that prints nothing of its own. */
const announce = (body: string): string => `printf '${READY}\\n'; ${body}`

const spawned: string[] = []

function spawn(options: {
  command: string
  args?: string[]
  raw?: boolean
  title?: string
}): string {
  const session = manager.spawn({
    command: options.command,
    args: options.args ?? [],
    raw: options.raw,
    title: options.title ?? `pty-conformance ${spawned.length}`,
    description: 'PTY conformance session',
    parentSessionId: 'pty-conformance',
    // Explicit geometry: the fallback size is per process and another suite can
    // leave one behind (see AGENTS.md). None of these cases care about size.
    cols: 120,
    rows: 40,
  })
  spawned.push(session.id)
  return session.id
}

function bufferText(id: string): string {
  return manager.getSession(id)?.buffer.readRaw() ?? ''
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/**
 * Block until the spawned command has started, so `stty raw` has run.
 *
 * Nothing guarantees the wrapper's `stty` finished before `manager.write` is
 * called; a byte written too early is processed under the cooked discipline and
 * the test would fail for a reason that has nothing to do with the code.
 */
async function waitForReady(id: string): Promise<void> {
  const ready = await waitFor(() => bufferText(id).includes(READY))
  expect(ready).toBe(true)
}

afterEach(() => {
  for (const id of spawned.splice(0)) {
    manager.kill(id, true)
  }
})

describe('PTY conformance: line discipline', () => {
  it('cooked: \\r is translated to \\n on input', async () => {
    // The default discipline. This is the observed failure mode: the program is
    // told "line feed" when the caller sent "carriage return".
    const id = spawn({ command: 'sh', args: ['-c', readOneByte] })
    await waitForReady(id)
    manager.write(id, '\r')

    const seen = await waitFor(() => bufferText(id).includes(`${BYTE_MARKER}:`))
    expect(seen).toBe(true)
    expect(bufferText(id)).toContain(`${BYTE_MARKER}:0a`)
    expect(bufferText(id)).not.toContain(`${BYTE_MARKER}:0d`)
  })

  it('raw: \\r reaches the program verbatim', async () => {
    // The fix. With `raw: true` the session runs `stty raw -echo` before the
    // command, so ICRNL is off and a carriage return stays a carriage return.
    const id = spawn({ command: 'sh', args: ['-c', readOneByte], raw: true })
    await waitForReady(id)
    manager.write(id, '\r')

    const seen = await waitFor(() => bufferText(id).includes(`${BYTE_MARKER}:`))
    expect(seen).toBe(true)
    expect(bufferText(id)).toContain(`${BYTE_MARKER}:0d`)
    expect(bufferText(id)).not.toContain(`${BYTE_MARKER}:0a`)
  })

  it('cooked: \\x03 interrupts a running process (ISIG)', async () => {
    const id = spawn({ command: 'sh', args: ['-c', announce('sleep 60')] })
    await waitForReady(id)
    manager.write(id, '\x03')

    const stopped = await waitFor(() => manager.getSession(id)?.status !== 'running', 3000)
    expect(stopped).toBe(true)
  })

  it('raw: \\x03 is data, not SIGINT', async () => {
    // Raw mode sets -isig, so Ctrl+C stops being a signal. This is why the
    // option is opt-in and documented as "not for shells": a shell would lose
    // its interrupt key.
    const id = spawn({ command: 'sh', args: ['-c', announce('sleep 60')], raw: true })
    await waitForReady(id)
    manager.write(id, '\x03')

    // Give a cooked-mode kill time to have happened, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(manager.getSession(id)?.status).toBe('running')
  })

  it('arrow keys pass through verbatim in both modes', async () => {
    // Arrow keys are escape sequences, which ICRNL does not touch. They are the
    // control for the bug: they worked while Enter did not, so a regression that
    // broke the sequence would be a different bug.
    const cooked = spawn({ command: 'sh', args: ['-c', announce('exec cat')] })
    await waitForReady(cooked)
    manager.write(cooked, '\x1b[A\r')
    const cookedSeen = await waitFor(() => bufferText(cooked).includes('\x1b[A'))
    expect(cookedSeen).toBe(true)

    const raw = spawn({ command: 'sh', args: ['-c', announce('exec cat')], raw: true })
    await waitForReady(raw)
    manager.write(raw, '\x1b[A')
    const rawSeen = await waitFor(() => bufferText(raw).includes('\x1b[A'))
    expect(rawSeen).toBe(true)
  })

  it('output fidelity: printf bytes survive round-trip', async () => {
    const id = spawn({ command: 'sh', args: ['-c', "printf 'line1\\nline2\\n'"] })
    const seen = await waitFor(() => bufferText(id).includes('line2'))
    expect(seen).toBe(true)
    expect(bufferText(id)).toContain('line1')
  })

  it('records raw mode on the session without rewriting the command', async () => {
    // The wrapper is an implementation detail: the session must still report the
    // command the caller asked for (`virsh console ...`, not `sh`), or `pty_list`
    // and the archive would lie about what is running.
    const id = spawn({
      command: 'sh',
      args: ['-c', 'sleep 60'],
      raw: true,
      title: 'raw record',
    })
    const session = manager.getSession(id)
    expect(session?.raw).toBe(true)
    expect(session?.command).toBe('sh')
    expect(session?.args).toEqual(['-c', 'sleep 60'])

    const info = manager.get(id)
    expect(info?.raw).toBe(true)
  })

  it('a cooked session does not claim raw mode', () => {
    const id = spawn({ command: 'sh', args: ['-c', 'true'] })
    expect(manager.get(id)?.raw).toBeUndefined()
  })
})
