/**
 * The exit tag after it crossed the process boundary.
 *
 * This is the case the unit tests missed: they built a live session with a real RingBuffer
 * and rendered the tag in the same process. The daemon sends the session as JSON, and the
 * buffer's `length` getter and `read()` method live on its prototype - JSON keeps neither.
 * The first case here is written against exactly that wire shape and fails on the current
 * code with `Output Lines: undefined` and an empty tail.
 */

import { describe, expect, it } from 'bun:test'

import { encodeMessage } from '../src/daemon/protocol.ts'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import {
  buildExitNotice,
  encodeExitNotice,
  exitNoticeData,
  exitNoticeFromWire,
} from '../src/plugin/pty/exit-notice.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'

function sessionWithOutput(): PTYSession {
  const buffer = new RingBuffer()
  buffer.append('\x1b[31merste Zeile\x1b[0m\n\x1b[32mzweite Zeile\x1b[0m\n')
  return {
    id: 'pty_test',
    title: 'Unit Tests',
    description: 'Unit-Tests nach Monatstag-Warnung',
    command: 'bun',
    args: ['run', 'unittest'],
    workdir: '/tmp',
    status: 'exited',
    exitCode: 1,
    pid: 12345,
    createdAt: new Date(),
    parentSessionId: 'parent-session-id',
    parentAgent: 'agent-two',
    notifyOnExit: true,
    timeoutSeconds: 1800,
    timedOut: false,
    buffer,
    process: null,
    cols: 240,
    rows: 80,
  }
}

interface WireMessage {
  params: { session: PTYSession; exitCode: number }
}

/** Exactly what `src/daemon/index.ts` puts on the socket today. */
function currentDaemonWire(): WireMessage {
  const message = encodeMessage({
    method: 'exit_notification',
    params: { session: sessionWithOutput(), exitCode: 1 },
  })
  return JSON.parse(message.trim()) as WireMessage
}

describe('exit notification across the daemon wire', () => {
  it('keeps the line count and the tail when the session crossed JSON', () => {
    // The old wire shape is still accepted: a new plugin can briefly meet an old daemon.
    const wire = currentDaemonWire()
    const data = exitNoticeFromWire(wire.params)
    expect(data).not.toBeNull()
    if (data === null) return
    const text = buildExitNotice(data)

    expect(text).toContain('Output Lines: 2')
    expect(text).toContain('Last Line: zweite Zeile')
    expect(text).not.toContain('\x1b[')
  })

  it('sends only the data the notice needs, and renders it on the client', () => {
    const data = exitNoticeData(sessionWithOutput(), 1)
    const wire = JSON.parse(encodeExitNotice(data).trim()) as {
      method: string
      params: Record<string, unknown>
    }

    expect(wire.method).toBe('exit_notification')
    // No live session, no RingBuffer internals and no raw ANSI on the wire.
    expect(Object.keys(wire.params)).not.toContain('session')
    expect(Object.keys(wire.params)).not.toContain('buffer')
    expect(JSON.stringify(wire.params)).not.toContain('\x1b[')
    expect(wire.params.lineCount).toBe(2)

    const received = exitNoticeFromWire(wire.params)
    expect(received).toEqual(data)
    const text = buildExitNotice(received ?? data)
    expect(text).toContain('Output Lines: 2')
    expect(text).toContain('Last Line: zweite Zeile')
    expect(text).toContain('Tail (last 2 non-empty lines):')
  })

  it('keeps the parent routing fields so the notice still wakes the right session', () => {
    const data = exitNoticeFromWire(
      exitNoticeData(sessionWithOutput(), 1) as unknown as Record<string, unknown>
    )
    expect(data?.parentSessionId).toBe('parent-session-id')
    expect(data?.parentAgent).toBe('agent-two')
    expect(data?.id).toBe('pty_test')
  })

  it('returns null instead of throwing on an unusable push', () => {
    expect(exitNoticeFromWire({})).toBeNull()
    expect(exitNoticeFromWire({ id: 'pty_x', tail: 'not an array' })).toBeNull()
  })

  it('counts a raw stream with no newlines as one long line, capped', () => {
    const session = sessionWithOutput()
    session.buffer = new RingBuffer()
    session.buffer.append('x'.repeat(500))

    const data = exitNoticeData(session, 1)
    expect(data.lineCount).toBe(1)
    expect(data.tail).toHaveLength(1)
    expect(data.tail[0]).toHaveLength(253) // 250 + '...'
  })
})
