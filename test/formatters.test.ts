import { describe, expect, it } from 'bun:test'
import {
  formatLine,
  formatPtyOutputBlock,
  formatSessionInfo,
  TRUNCATION_MARKER,
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
    charCount: 1600,
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
      '  Lines: 3 | Chars: 1600',
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
    expect(formatPtyOutputBlock('pty_x', 'exited', ['one'], { pattern: 'foo' })).toBe(
      '<pty_output id="pty_x" status="exited" pattern="foo">\none\n</pty_output>'
    )
  })

  it('reports how much of the buffer was shown and where to resume', () => {
    const block = formatPtyOutputBlock('pty_x', 'running', ['one'], {
      truncatedLines: 1,
      nextSince: 4096,
      chars: { shown: 4096, total: 9000 },
    })
    expect(block).toContain('truncated="true"')
    expect(block).toContain('truncatedLines="1"')
    expect(block).toContain('nextSince="4096"')
    expect(block).toContain('chars="4096/9000"')
  })

  it('omits the truncation attributes on a result that was not cut', () => {
    const block = formatPtyOutputBlock('pty_x', 'running', ['one'], {
      chars: { shown: 3, total: 3 },
      nextSince: null,
    })
    expect(block).not.toContain('truncated')
    expect(block).not.toContain('nextSince')
  })
})

describe('TRUNCATION_MARKER', () => {
  it('states both counts so a cut cannot be mistaken for the end of the data', () => {
    expect(TRUNCATION_MARKER(3, 6)).toBe('… [truncated: 3 of 6 chars]')
  })

  it('is searchable, unlike a bare ellipsis that program output can also contain', () => {
    expect(TRUNCATION_MARKER(1, 2)).toContain('truncated:')
  })
})

describe('formatLine', () => {
  it('pads line numbers to five digits', () => {
    expect(formatLine('hello', 1, 5).text).toBe('00001| hello')
    expect(formatLine('hello', 12345, 5).text).toBe('12345| hello')
  })

  it('returns a line that fits untouched and says it was not truncated', () => {
    expect(formatLine('abcdef', 2, 6)).toEqual({
      text: '00002| abcdef',
      truncated: false,
      shownChars: 6,
      totalChars: 6,
    })
  })

  it('cuts at the budget and reports both counts', () => {
    // The old version returned '00002| abc...', which is indistinguishable from
    // a line whose content genuinely ends in three dots.
    expect(formatLine('abcdef', 2, 3)).toEqual({
      text: '00002| abc',
      truncated: true,
      shownChars: 3,
      totalChars: 6,
    })
  })

  it('treats a zero budget as an empty delivery rather than a negative slice', () => {
    expect(formatLine('abcdef', 1, 0)).toEqual({
      text: '00001| ',
      truncated: true,
      shownChars: 0,
      totalChars: 6,
    })
  })
})
