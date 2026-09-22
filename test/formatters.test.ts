import { describe, expect, it } from 'bun:test'
import {
  formatLine,
  formatPtyOutputBlock,
  formatSessionInfo,
} from '../src/plugin/pty/formatters.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

function buildSession(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_fmt',
    title: 'Formatter session',
    command: 'echo',
    args: ['hello'],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 99,
    createdAt: '2026-01-01T00:00:00.000Z',
    lineCount: 3,
    ...overrides,
  }
}

describe('formatSessionInfo', () => {
  it('formats a running session without optional annotations', () => {
    expect(formatSessionInfo(buildSession())).toEqual([
      '[pty_fmt] Formatter session',
      '  Command: echo hello',
      '  Status: running',
      '  PID: 99',
      '  Lines: 3',
      '  Workdir: /tmp',
      '  Started: 2026-01-01T00:00:00.000Z',
      '',
    ])
  })

  it('includes timeout, exit code and signal annotations', () => {
    const lines = formatSessionInfo(
      buildSession({
        status: 'exited',
        timedOut: true,
        exitCode: 137,
        exitSignal: 'SIGKILL',
        timeoutSeconds: 30,
      })
    )

    expect(lines[2]).toBe('  Status: exited | timed out | exit: 137 | signal: SIGKILL')
    expect(lines[3]).toBe('  PID: 99 | timeout: 30s')
  })

  it('reports end time and duration for a finished session', () => {
    const lines = formatSessionInfo(
      buildSession({ status: 'exited', endedAt: '2026-01-01T00:18:00.000Z' })
    )

    expect(lines).toContain('  Started: 2026-01-01T00:00:00.000Z')
    expect(lines).toContain('  Ended: 2026-01-01T00:18:00.000Z')
    expect(lines).toContain('  Duration: 18m')
  })
})

describe('formatPtyOutputBlock', () => {
  it('omits the pattern attribute when none is supplied', () => {
    expect(formatPtyOutputBlock('pty_x', 'running', ['one', 'two'])).toBe(
      '<pty_output id="pty_x" status="running">\none\ntwo\n</pty_output>'
    )
  })

  it('includes the pattern attribute when supplied', () => {
    expect(formatPtyOutputBlock('pty_x', 'exited', ['one'], 'foo')).toBe(
      '<pty_output id="pty_x" status="exited" pattern="foo">\none\n</pty_output>'
    )
  })
})

describe('formatLine', () => {
  it('pads line numbers to five digits', () => {
    expect(formatLine('hello', 1)).toBe('00001| hello')
    expect(formatLine('hello', 12345)).toBe('12345| hello')
  })

  it('truncates lines longer than maxLength', () => {
    expect(formatLine('abcdef', 2, 3)).toBe('00002| abc...')
    expect(formatLine('abcdef', 2, 6)).toBe('00002| abcdef')
  })
})
