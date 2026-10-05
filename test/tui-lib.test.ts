import { describe, expect, it } from 'bun:test'

import {
  clearActionLabel,
  decodeBuffer,
  finishedSessions,
  formatDetail,
  formatDuration,
  headerLabel,
  isFinished,
  isPtyHealth,
  rowLabel,
  rowTone,
  sessionDurationMs,
  tail,
  type PanelSession,
} from '../src/tui/lib.ts'

/**
 * The panel's decisions, without a TUI.
 *
 * Everything here is a thing the terminal shows and a human reads, so the tests
 * are about what the panel *claims*, not about how it draws: a row that says
 * "exit ?" for a session that was killed looks exactly like a bug.
 */

const session = (over: Partial<PanelSession> = {}): PanelSession => ({
  id: 'pty_1',
  ...over,
})

describe('rowLabel', () => {
  it('shows the line count while running', () => {
    expect(rowLabel(session({ title: 'dev', status: 'running', lineCount: 120 }))).toBe('dev  120L')
  })

  it('shows the exit code of a process that ended on its own', () => {
    expect(rowLabel(session({ title: 'build', status: 'exited', exitCode: 0 }))).toBe(
      'build  exit 0'
    )
  })

  it('shows the exit code of one that failed', () => {
    expect(rowLabel(session({ title: 'build', status: 'exited', exitCode: 2 }))).toBe(
      'build  exit 2'
    )
  })

  // The case that made this worth a comment upstream: `killing` and `killed`
  // carry no exit code, so `exit ${code}` with a missing one renders "exit ?".
  it('names the status when there is no exit code, rather than showing a question mark', () => {
    expect(rowLabel(session({ title: 'dev', status: 'killing' }))).toBe('dev  killing')
    expect(rowLabel(session({ title: 'dev', status: 'killed' }))).toBe('dev  killed')
  })

  it('names the signal when a process was signalled rather than exiting', () => {
    expect(rowLabel(session({ title: 'dev', status: 'exited', exitSignal: 'SIGTERM' }))).toBe(
      'dev  signal SIGTERM'
    )
  })

  it('falls back to untitled and to a zero line count', () => {
    expect(rowLabel(session({ status: 'running' }))).toBe('untitled  0L')
  })

  it('truncates a long title instead of pushing the state out of the panel', () => {
    const label = rowLabel(session({ title: 'x'.repeat(60), status: 'running', lineCount: 5 }))
    // 24 columns for the title including the ellipsis, then the state.
    expect(label).toBe(`${'x'.repeat(23)}…  5L`)
    expect(label.length).toBeLessThanOrEqual(28)
  })
})

describe('rowTone', () => {
  it('is success while running, error on a non-zero exit, muted otherwise', () => {
    expect(rowTone(session({ status: 'running' }))).toBe('success')
    expect(rowTone(session({ status: 'exited', exitCode: 1 }))).toBe('error')
    expect(rowTone(session({ status: 'exited', exitCode: 0 }))).toBe('muted')
    expect(rowTone(session({ status: 'killed' }))).toBe('muted')
  })
})

describe('isFinished and finishedSessions', () => {
  it('counts exited and killed as finished', () => {
    expect(isFinished(session({ status: 'exited' }))).toBe(true)
    expect(isFinished(session({ status: 'killed' }))).toBe(true)
  })

  // A `killing` session has been asked to die but has not. Clearing it would
  // race the teardown, so it is deliberately not finished.
  it('does not count a killing session as finished', () => {
    expect(isFinished(session({ status: 'killing' }))).toBe(false)
    expect(isFinished(session({ status: 'running' }))).toBe(false)
  })

  it('keeps the list order and leaves the rest alone', () => {
    const list = [
      session({ id: 'a', status: 'exited' }),
      session({ id: 'b', status: 'running' }),
      session({ id: 'c', status: 'killed' }),
    ]
    expect(finishedSessions(list).map((s) => s.id)).toEqual(['a', 'c'])
  })
})

describe('clearActionLabel', () => {
  it('offers the action only when there is something finished to clear', () => {
    expect(clearActionLabel([session({ status: 'exited' })])).toBe('(clear finished)')
    // Null rather than a disabled label: a control that would delete nothing must
    // not be offered at all, or it reads as touching live sessions.
    expect(clearActionLabel([session({ status: 'running' })])).toBeNull()
    expect(clearActionLabel([])).toBeNull()
  })

  it('offers it for a killed session, which has no running process left', () => {
    expect(clearActionLabel([session({ status: 'killing' }), session({ status: 'killed' })])).toBe(
      '(clear finished)'
    )
  })
})

describe('headerLabel', () => {
  it('points the chevron at what a click would do', () => {
    expect(headerLabel({ collapsed: true, status: '2 sessions' })).toBe('▶ PTY  2 sessions')
    expect(headerLabel({ collapsed: false, status: '1 session' })).toBe('▼ PTY  1 session')
  })
})

describe('formatDetail', () => {
  it('puts the identity on one line and the invocation on the next', () => {
    const detail = formatDetail(
      session({
        id: 'pty_7',
        status: 'running',
        pid: 4242,
        lineCount: 88,
        command: 'bun',
        args: ['run', 'dev'],
        workdir: '/srv/app',
      })
    )
    expect(detail.split('\n')).toEqual([
      'pty_7  running  pid 4242  lines 88',
      'bun run dev  ·  /srv/app',
    ])
  })

  it('survives a session with nothing filled in', () => {
    expect(formatDetail(session())).toBe('pty_1  ?  pid ?  lines 0')
  })

  it('drops a non-string argument rather than printing undefined', () => {
    const broken = {
      ...session({ command: 'bun' }),
      args: [1, 'run', null],
    } as unknown as PanelSession
    expect(formatDetail(broken)).toContain('bun run')
  })
})

describe('sessionDurationMs', () => {
  const start = '2026-01-01T10:00:00.000Z'

  it('measures a running session to the clock the caller supplies', () => {
    const ms = sessionDurationMs(
      session({ createdAt: start }),
      Date.parse('2026-01-01T10:02:30.000Z')
    )
    expect(ms).toBe(150_000)
  })

  // This is what `exitAt` is for: without it, a stopped session would measure to
  // "now" and a transcript read an hour later would claim to have run an hour.
  it('measures a stopped session to its exit, not to now', () => {
    const ms = sessionDurationMs(
      session({ createdAt: start, exitAt: '2026-01-01T10:00:05.000Z' }),
      Date.parse('2026-01-01T11:00:00.000Z')
    )
    expect(ms).toBe(5000)
  })

  it('returns null when the start is missing or unreadable', () => {
    expect(sessionDurationMs(session({}), 1_000)).toBeNull()
    expect(sessionDurationMs(session({ createdAt: 'not a date' }), 1_000)).toBeNull()
  })

  // A clock that moved backwards between the server and the panel must not
  // produce a negative duration; the formatter floors it, and this pins why.
  it('reports a negative span rather than null when the clock went backwards', () => {
    const ms = sessionDurationMs(
      session({ createdAt: '2026-01-01T10:05:00.000Z', exitAt: '2026-01-01T10:00:00.000Z' }),
      1_000
    )
    expect(ms).toBeLessThan(0)
    expect(formatDuration(ms)).toBe('0s')
  })
})

describe('formatDuration', () => {
  it('counts in seconds below a minute, zero-padded seconds after it', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(999)).toBe('0s')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
  })

  it('counts in minutes above an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m')
    expect(formatDuration(7_380_000)).toBe('2h 03m')
  })

  it('floors rubbish to zero rather than rendering NaN', () => {
    expect(formatDuration(null)).toBe('0s')
    expect(formatDuration(undefined)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
    expect(formatDuration(-5000)).toBe('0s')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})

describe('decodeBuffer', () => {
  it('unwraps the {plain, byteLength} envelope the endpoint actually returns', () => {
    expect(decodeBuffer({ plain: 'a\r\nb', byteLength: 4 })).toBe('a\nb')
  })

  it('accepts a bare string, so a direct body is not punished for it', () => {
    expect(decodeBuffer('a\r\nb')).toBe('a\nb')
  })

  it('returns empty for anything else rather than throwing', () => {
    expect(decodeBuffer(null)).toBe('')
    expect(decodeBuffer(undefined)).toBe('')
    expect(decodeBuffer(42)).toBe('')
    expect(decodeBuffer({ byteLength: 4 })).toBe('')
  })
})

describe('tail', () => {
  // Exactly `lines`, never `lines` plus a marker: the caller feeds the result to a
  // box that shows only as many rows as it has, so a marker on top would push the
  // newest line out of sight. That is the reason for the off-by-one-looking shape.
  it('returns exactly the requested number of lines when it cuts', () => {
    expect(tail('a\nb\nc\nd', 2)).toBe('…\nd')
    expect(tail('a\nb\nc\nd', 3)).toBe('…\nc\nd')
    expect(tail('a\nb\nc\nd', 4)).toBe('a\nb\nc\nd')
  })

  it('returns everything when it fits', () => {
    expect(tail('a\nb\nc', 5)).toBe('a\nb\nc')
  })

  it('does not claim to have cut when the count is exactly the length', () => {
    expect(tail('a\nb', 2)).toBe('a\nb')
  })

  it('ends with the newest line, so a viewport shows the newest output', () => {
    expect(tail('a\nb\nc\nd', 2).endsWith('d')).toBe(true)
    expect(tail('a\nb\nc\nd', 3).endsWith('d')).toBe(true)
  })

  it('has nothing to show for a viewport of less than one line', () => {
    expect(tail('a\nb\nc', 0)).toBe('')
    expect(tail('a\nb\nc', -3)).toBe('')
    // One line is the marker or nothing: there is no room for both.
    expect(tail('a\nb\nc', 1)).toBe('…')
    expect(tail('a', 1)).toBe('a')
  })
})

describe('isPtyHealth', () => {
  it('accepts the payload a PTY server serves', () => {
    expect(isPtyHealth({ status: 'healthy', sessions: { total: 2 } })).toBe(true)
  })

  // The reason this check exists at all: CUPS owns [::1]:631 on some machines and
  // returns an HTML error page there, which is just as much "something answered".
  it('rejects anything else that answered on the port', () => {
    expect(isPtyHealth({ status: 'ok' })).toBe(false)
    expect(isPtyHealth({ status: 'healthy' })).toBe(false)
    expect(isPtyHealth({ status: 'healthy', sessions: 7 })).toBe(false)
    expect(isPtyHealth('<html>CUPS</html>')).toBe(false)
    expect(isPtyHealth(null)).toBe(false)
  })
})
