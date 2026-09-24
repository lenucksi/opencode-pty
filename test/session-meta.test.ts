import { describe, expect, it } from 'bun:test'

import {
  formatClock,
  formatDuration,
  groupSessionsByParent,
  parentSessionGroupTitle,
  sessionCommandLine,
  sessionDetailLine,
  sessionSidebarMeta,
  sessionTiming,
  sessionTooltip,
} from '../src/web/shared/session-meta.ts'
import type { PTYSessionInfo } from '../src/web/shared/types.ts'

function session(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_meta',
    title: 'Session',
    command: 'ansible-playbook',
    args: ['site.yml', '--limit', 'host'],
    workdir: '/srv/ansible',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 4242,
    createdAt: '2026-09-21T15:00:00.000Z',
    lineCount: 12,
    ...overrides,
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value in test')
  return value
}

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration('2026-09-21T15:00:00.000Z', '2026-09-21T15:00:42.000Z')).toBe('42s')
    expect(formatDuration('2026-09-21T15:00:00.000Z', '2026-09-21T15:18:00.000Z')).toBe('18m')
    expect(formatDuration('2026-09-21T15:00:00.000Z', '2026-09-21T17:04:00.000Z')).toBe('2h 04m')
    expect(formatDuration('2026-09-21T15:00:00.000Z', '2026-09-23T18:00:00.000Z')).toBe('2d 3h')
  })

  it('returns nothing for nonsense input', () => {
    expect(formatDuration('not-a-date', '2026-09-21T15:00:00.000Z')).toBe('')
    expect(formatDuration('2026-09-21T15:00:00.000Z', '2026-09-21T14:00:00.000Z')).toBe('')
  })

  it('measures a running session against now', () => {
    // 90 s is reported as one full minute (the next minute is not reached yet).
    expect(formatDuration(new Date(Date.now() - 90_000).toISOString())).toBe('1m')
  })
})

describe('formatClock', () => {
  it('formats a timestamp as a local wall clock', () => {
    expect(formatClock('2026-09-21T15:00:00.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('returns nothing when there is no usable time', () => {
    expect(formatClock(undefined)).toBe('')
    expect(formatClock('')).toBe('')
    expect(formatClock('yesterday')).toBe('')
  })
})

describe('sessionCommandLine', () => {
  it('includes the arguments', () => {
    expect(sessionCommandLine(session())).toBe('ansible-playbook site.yml --limit host')
  })
})

describe('sessionTiming', () => {
  it('describes a running session with its start and elapsed time', () => {
    const text = sessionTiming(session())

    expect(text).toContain('started ')
    expect(text).toContain('running ')
  })

  it('describes a finished session with start, end and duration', () => {
    const text = sessionTiming(session({ status: 'exited', endedAt: '2026-09-21T15:18:00.000Z' }))

    expect(text).toContain('started ')
    expect(text).toContain('ended ')
    expect(text).toContain('18m')
  })

  it('treats a killing session as still running', () => {
    expect(sessionTiming(session({ status: 'killing' }))).toContain('running ')
  })
})

describe('sessionDetailLine', () => {
  it('joins pid, timing, command and size', () => {
    const line = sessionDetailLine(
      session({ status: 'exited', endedAt: '2026-09-21T15:18:00.000Z' })
    )

    expect(line).toContain('PID 4242')
    expect(line).toContain('18m')
    expect(line).toContain('ansible-playbook site.yml --limit host')
    expect(line).toContain('12 lines')
  })
})

describe('sessionSidebarMeta', () => {
  it('keeps the timings and leaves the line count to the tooltip', () => {
    const line = sessionSidebarMeta(
      session({ status: 'exited', endedAt: '2026-09-21T15:18:00.000Z' })
    )

    expect(line).toContain('PID 4242')
    expect(line).toContain('18m')
    expect(line).not.toContain('lines')
  })
})

describe('sessionTooltip', () => {
  it('lists the id, command and workdir on separate lines', () => {
    expect(sessionTooltip(session()).split('\n')).toEqual([
      'pty_meta',
      'ansible-playbook site.yml --limit host',
      'workdir: /srv/ansible',
    ])
  })

  it('includes the requesting OpenCode session when known', () => {
    const lines = sessionTooltip(
      session({ parentSessionId: 'ses_parent', parentAgent: 'build' })
    ).split('\n')

    expect(lines).toContain('parent session: ses_parent (build)')
  })
})

describe('groupSessionsByParent', () => {
  it('groups by parent and orders groups and children by newest activity', () => {
    const groups = groupSessionsByParent([
      session({
        id: 'b-old',
        parentSessionId: 'ses_b',
        parentAgent: 'build',
        createdAt: '2026-09-21T15:00:00.000Z',
      }),
      session({
        id: 'b-new',
        parentSessionId: 'ses_b',
        parentAgent: 'plan',
        createdAt: '2026-09-21T15:30:00.000Z',
      }),
      session({
        id: 'a-finished',
        parentSessionId: 'ses_a',
        status: 'exited',
        createdAt: '2026-09-21T14:00:00.000Z',
        endedAt: '2026-09-21T15:45:00.000Z',
      }),
    ])

    expect(groups.map((group) => group.parentSessionId)).toEqual(['ses_a', 'ses_b'])
    expect(groups[1]?.sessions.map((child) => child.id)).toEqual(['b-new', 'b-old'])
    expect(groups[1]?.parentAgent).toBe('plan')
  })

  it('keeps legacy sessions without a parent together', () => {
    const groups = groupSessionsByParent([session({ id: 'legacy' })])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('')
    expect(groups[0]?.parentSessionId).toBeUndefined()
  })
})

describe('parentSessionGroupTitle', () => {
  it('prefers a resolved OpenCode title', () => {
    const groups = groupSessionsByParent([
      session({ id: 'one', parentSessionId: 'ses_named', parentAgent: 'build' }),
    ])

    expect(parentSessionGroupTitle(required(groups[0]), { ses_named: 'Deployment work' })).toBe(
      'Deployment work'
    )
  })

  it('falls back to the stable id and labels manual web API sessions', () => {
    const [missing] = groupSessionsByParent([
      session({ id: 'one', parentSessionId: 'ses_missing' }),
    ])
    const [manual] = groupSessionsByParent([session({ id: 'two', parentSessionId: 'web-api' })])

    expect(parentSessionGroupTitle(required(missing), {})).toBe('Session ses_missing')
    expect(parentSessionGroupTitle(required(manual), {})).toBe('Web API / manual')
  })
})
