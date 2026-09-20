import { describe, expect, it } from 'bun:test'

import { formatLogLine, ptyLogPath } from '../src/plugin/pty/plugin-log.ts'

describe('ptyLogPath', () => {
  it('follows XDG_STATE_HOME', () => {
    expect(ptyLogPath({ XDG_STATE_HOME: '/state', HOME: '/home/u' })).toBe(
      '/state/opencode/opencode-pty.log'
    )
  })

  it('falls back to ~/.local/state', () => {
    expect(ptyLogPath({ HOME: '/home/u' })).toBe('/home/u/.local/state/opencode/opencode-pty.log')
  })

  it('falls back to /tmp when there is no HOME either', () => {
    expect(ptyLogPath({})).toBe('/tmp/opencode/opencode-pty.log')
  })
})

describe('formatLogLine', () => {
  const now = new Date('2026-09-20T17:32:00.000Z')

  it('writes a timestamped level and message', () => {
    expect(formatLogLine('info', 'exit notification delivered', undefined, now)).toBe(
      '2026-09-20T17:32:00.000Z INFO exit notification delivered\n'
    )
  })

  it('appends structured details', () => {
    expect(formatLogLine('warn', 'no notification', { sessionID: 'pty_1' }, now)).toBe(
      '2026-09-20T17:32:00.000Z WARN no notification {"sessionID":"pty_1"}\n'
    )
  })

  it('renders errors readably instead of as an empty object', () => {
    expect(formatLogLine('error', 'delivery failed', new TypeError('boom'), now)).toBe(
      '2026-09-20T17:32:00.000Z ERROR delivery failed TypeError: boom\n'
    )
  })
})
