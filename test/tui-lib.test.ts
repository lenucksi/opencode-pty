import { describe, expect, it } from 'bun:test'

import {
  archiveLabel,
  clearActionLabel,
  decodeScreen,
  finishedSessions,
  formatDetail,
  formatStamp,
  formatDuration,
  headerLabel,
  isFinished,
  isPtyHealth,
  type PanelSession,
  resolveParentTitles,
  rowLabel,
  sessionIdentity,
  rowTone,
  sessionDurationMs,
  tail,
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

  // Older archive records carry `endedAt` instead of `exitAt`: the field was added in
  // the release, and the archive is read after a restart. A record the panel cannot
  // time would otherwise show the hours since the panel opened, which is the shape the
  // reader measured (a 19-second build read as 17h).
  it('measures a stopped session to endedAt when there is no exitAt', () => {
    const ms = sessionDurationMs(
      session({ createdAt: start, endedAt: '2026-01-01T10:00:19.000Z' }),
      Date.parse('2026-01-01T11:00:00.000Z')
    )
    expect(ms).toBe(19_000)
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
    // The span is reported truthfully rather than nulled, and the LABEL is empty. An old
    // floor rendered `0s` here, which claimed the run lasted nothing; empty says the
    // clock is not to be trusted, and the caller already renders empty deliberately.
    expect(formatDuration(ms)).toBe('')
  })
})

describe('formatDuration', () => {
  // Delegates to the shared formatter with the `precise` preset; the preset itself is
  // tested in `session-meta.test.ts`. What is pinned HERE is that the panel asks for the
  // precise one and that rubbish renders as nothing rather than as `NaN`.
  it('counts in seconds below a minute, zero-padded seconds after it', () => {
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
  })

  // Rounded, not floored: a run of 999ms reads as one second rather than zero. The old
  // implementation floored, and its floor was the reason `0s` appeared on a timer for a
  // process that had demonstrably been alive.
  it('rounds a sub-second run up to a second, and shows nothing for no run at all', () => {
    expect(formatDuration(999)).toBe('1s')
    expect(formatDuration(0)).toBe('')
  })

  it('counts in minutes above an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m')
    expect(formatDuration(7_380_000)).toBe('2h 03m')
  })

  // Days are for the web sidebar, which has the room. A 40-column column shows hours and
  // leaves the reader to wonder - and the shared preset is where that is decided, not here.
  it('never writes days, even for a very long run', () => {
    expect(formatDuration(31 * 3_600_000)).toBe('31h')
  })

  // Empty, not `NaN` and not `0s`. `NaN` in a corner of the terminal is the failure this
  // guards against, and `0s` was the old answer to it - a claim that the run lasted
  // nothing, on a clock that cannot be trusted.
  it('renders rubbish as nothing rather than NaN or a zero duration', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(-5000)).toBe('')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('decodeScreen', () => {
  // The endpoint returns the RENDERED screen, one string per row with trailing blanks
  // already removed. Joining the rows is the whole of the decoding - which is the point:
  // there is no ANSI to strip and no cursor position to lose, because the emulator has
  // already applied both.
  // The old rule kept even the trailing blank rows: the blank bottom of a screen is
  // shape, and a fresh 81-row screen half-printed produced a console of blanks with a
  // scrollbar before the screen was full - measured. The consumer trims after.
  it('joins the screen rows into displayable text, trailing blanks dropped', () => {
    expect(decodeScreen({ id: 'pty_1', cols: 40, rows: 3, lines: ['top', 'second'] })).toBe(
      'top\nsecond'
    )
  })

  // The inverse still holds: a blank row BETWEEN content belongs to the program.
  it('keeps an inner blank row', () => {
    expect(decodeScreen({ id: 'pty_1', cols: 40, rows: 5, lines: ['top', '', 'bottom', ''] })).toBe(
      'top\n\nbottom'
    )
  })

  // A row too wide for the screen occupies two screen rows, and that is what the program
  // shows - so this must not silently join them into one longer line.
  it('keeps the rows separate rather than rejoining a wrapped line', () => {
    expect(decodeScreen({ lines: ['first half', 'second half'] })).toBe('first half\nsecond half')
  })

  it('accepts a bare array, so a direct body is not punished for it', () => {
    expect(decodeScreen(['a', 'b'])).toBe('a\nb')
  })

  // Anything unreadable yields an empty box rather than throwing: a dialog that cannot
  // show output must not take the panel's refresh down with it.
  it('returns empty for anything else rather than throwing', () => {
    expect(decodeScreen(null)).toBe('')
    expect(decodeScreen(undefined)).toBe('')
    expect(decodeScreen(42)).toBe('')
    expect(decodeScreen({ cols: 40, rows: 3 })).toBe('')
  })

  // A single unusable row must not poison the rows around it: the screen is an array of
  // strings from the wire, and one surprise in it should cost one row, not all of them.
  it('drops unusable rows and keeps the rest', () => {
    expect(decodeScreen({ lines: ['good', 42, null, 'also good'] })).toBe('good\nalso good')
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
describe('archiveLabel', () => {
  // Absent unless something failed. A finished session with an exit 0 is a record, not
  // an event, and the expansion shows only failures - so a line offering to open
  // nothing would be a control with no answer.
  it('says nothing when nothing finished', () => {
    expect(archiveLabel({ finished: 0, failed: 0, shown: 0, expanded: false })).toBeNull()
  })

  it('says nothing when nothing failed, however many finished', () => {
    expect(archiveLabel({ finished: 200, failed: 0, shown: 0, expanded: false })).toBeNull()
    expect(archiveLabel({ finished: 200, failed: 0, shown: 0, expanded: true })).toBeNull()
  })

  it('names the archive and the failures', () => {
    expect(archiveLabel({ finished: 200, failed: 3, shown: 3, expanded: false })).toBe(
      '\u25b8 200 finished \u00b7 3 failed'
    )
  })

  // The list is capped and the count is not, so when the two differ the line has to say
  // so - otherwise it describes the screen rather than the archive.
  it('admits it is showing a subset when the cap cut the list', () => {
    expect(archiveLabel({ finished: 200, failed: 17, shown: 10, expanded: true })).toBe(
      '\u25be 200 finished \u00b7 10 of 17 failed'
    )
  })

  // The arrow points at what a click would do, so it is the only difference between the
  // two states a reader has to act on.
  it('the arrow follows the expansion', () => {
    const closed = archiveLabel({ finished: 5, failed: 1, shown: 1, expanded: false })
    const open = archiveLabel({ finished: 5, failed: 1, shown: 1, expanded: true })
    expect(closed?.startsWith('\u25b8')).toBe(true)
    expect(open?.startsWith('\u25be')).toBe(true)
  })
})

describe('resolveParentTitles', () => {
  const withParent = (id: string, parent?: string): PanelSession =>
    session({ id, ...(parent === undefined ? {} : { parentSessionId: parent }) })

  it('collects one title per parent, however many sessions carry it', () => {
    const asked: string[] = []
    const titles = resolveParentTitles(
      [withParent('a', 'ses_one'), withParent('b', 'ses_one'), withParent('c', 'ses_two')],
      (id) => {
        asked.push(id)
        return `title of ${id}`
      }
    )
    expect(titles).toEqual({ ses_one: 'title of ses_one', ses_two: 'title of ses_two' })
    // Asked once per parent, not once per session: a repeated lookup would be a lookup per row,
    // on every poll.
    expect(asked).toEqual(['ses_one', 'ses_two'])
  })

  // A conversation whose parent is gone yields no entry, and the heading then falls back to the
  // stable session id rather than disappearing - so the absence has to stay an absence.
  it('leaves out a parent the host cannot name', () => {
    expect(resolveParentTitles([withParent('a', 'ses_gone')], () => undefined)).toEqual({})
    expect(resolveParentTitles([withParent('a', 'ses_blank')], () => '   ')).toEqual({})
  })

  // A session started by hand has no parent at all, and must not be looked up as the empty id.
  it('never asks about a session with no parent', () => {
    const asked: string[] = []
    const titles = resolveParentTitles([withParent('a'), withParent('b', '  ')], (id) => {
      asked.push(id)
      return 'x'
    })
    expect(titles).toEqual({})
    expect(asked).toEqual([])
  })

  it('trims the title the host returns', () => {
    expect(resolveParentTitles([withParent('a', 'ses_one')], () => '  Build  ')).toEqual({
      ses_one: 'Build',
    })
  })
})

describe('sessionIdentity', () => {
  const started = '2026-10-14T22:24:00Z'

  it('names the four things that identify a process', () => {
    const line = sessionIdentity(
      session({
        parentSessionId: 'ses_davx5',
        title: 'Lizenz-Hashes erzeugen',
        status: 'exited',
        exitCode: 1,
        createdAt: started,
      }),
      'davx5 build'
    )
    expect(line).toContain('Lizenz-Hashes erzeugen')
    expect(line).toContain(formatStamp(started))
    // The state comes from the same helper a row uses, so the two cannot disagree.
    expect(line).toContain('exit 1')
    expect(line).toContain('started by davx5 build')
  })

  // The measured case: the parent is a conversation from another project, so the host has no title
  // for it - and that is NOT the same as a session nobody\u2019s conversation started.
  it('falls back to the parent id when the host cannot name it', () => {
    const line = sessionIdentity(session({ parentSessionId: 'ses_elsewhere' }), undefined)
    expect(line).toContain('started by ses_elsewhere')
    expect(line).not.toContain('started by hand')
  })

  it('says so when no conversation started it', () => {
    const line = sessionIdentity(session({ parentSessionId: undefined }), 'davx5 build')
    expect(line).toContain('started by hand')
  })

  // Never just separators: an untitled session is named by its id.
  it('falls back to the id for a session with no title', () => {
    const line = sessionIdentity(session({ title: '', status: 'running', lineCount: 7 }), undefined)
    expect(line).toContain('pty_1')
    expect(line).toContain('7L')
  })
})

describe('formatStamp', () => {
  it('is empty for a missing or unreadable stamp', () => {
    expect(formatStamp(undefined)).toBe('')
    expect(formatStamp('not a date')).toBe('')
  })

  // Locale-formatted on purpose, so the shape is all that can be asserted - the reader is the one
  // who has to read it.
  it('renders a local date and time', () => {
    const stamp = formatStamp(started_iso())
    expect(stamp).toContain('2026')
    expect(stamp.length).toBeGreaterThan(8)
  })

  function started_iso(): string {
    return '2026-10-14T22:24:00Z'
  }
})
