import { describe, expect, it } from 'bun:test'

import type { PTYSessionInfo } from '../src/web/shared/types.ts'
import {
  countSessions,
  filterGroups,
  normalizeQuery,
  sessionMatches,
} from '../src/web/shared/session-search.ts'

/**
 * The sidebar filter is pure, so the rules that are easy to get wrong - a group
 * title match keeping the whole group, a child match hiding unrelated siblings,
 * counters matching the filtered set - are testable without a browser.
 */

function session(overrides: Partial<PTYSessionInfo> & { id: string }): PTYSessionInfo {
  return {
    title: overrides.id,
    command: 'bash',
    args: [],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 1,
    lineCount: 0,
    createdAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  }
}

const group = (key: string, title: string, sessions: PTYSessionInfo[]) => ({ key, title, sessions })

const groups = [
  group('a', 'Refactor CI pipeline', [
    session({ id: 'pty_a1', description: 'build', command: 'bun', args: ['run', 'build'] }),
    session({ id: 'pty_a2', description: 'migrate' }),
  ]),
  group('b', 'Ship metrics endpoint', [
    session({ id: 'pty_b1', description: 'api', command: 'bun', args: ['src/cli.ts', 'tui2'] }),
  ]),
]

const titleOf = (g: (typeof groups)[number]) => g.title

describe('normalizeQuery', () => {
  it('treats an empty or whitespace query as inactive', () => {
    expect(normalizeQuery('')).toBeNull()
    expect(normalizeQuery('   ')).toBeNull()
  })

  it('lowercases and trims a real query', () => {
    expect(normalizeQuery('  Build  ')).toBe('build')
  })
})

describe('sessionMatches', () => {
  const build = groups[0]?.sessions[0] as PTYSessionInfo
  const api = groups[1]?.sessions[0] as PTYSessionInfo

  it('matches the description', () => {
    expect(sessionMatches(build, 'build')).toBe(true)
  })

  it('matches the command line including arguments', () => {
    expect(sessionMatches(api, 'src/cli.ts')).toBe(true)
    expect(sessionMatches(api, 'tui2')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(sessionMatches(build, 'BUILD')).toBe(true)
  })

  it('rejects a non-match', () => {
    expect(sessionMatches(build, 'kubernetes')).toBe(false)
  })
})

describe('filterGroups', () => {
  it('returns everything for an empty query', () => {
    const result = filterGroups(groups, titleOf, '')
    expect(result).toHaveLength(2)
    expect(countSessions(result)).toBe(3)
  })

  it('keeps the whole group when the group title matches', () => {
    const result = filterGroups(groups, titleOf, 'ci pipeline')
    expect(result).toHaveLength(1)
    expect(result[0]?.groupMatched).toBe(true)
    // Both children stay, not just the one that happened to match.
    expect(result[0]?.sessions).toHaveLength(2)
  })

  it('keeps only the matching child when the group title does not match', () => {
    const result = filterGroups(groups, titleOf, 'migrate')
    expect(result).toHaveLength(1)
    expect(result[0]?.groupMatched).toBe(false)
    expect(result[0]?.sessions.map((s) => s.id)).toEqual(['pty_a2'])
  })

  it('drops a group whose title and every child miss', () => {
    const result = filterGroups(groups, titleOf, 'kubernetes')
    expect(result).toHaveLength(0)
    expect(countSessions(result)).toBe(0)
  })

  it('matches a group title case insensitively', () => {
    const result = filterGroups(groups, titleOf, 'SHIP METRICS')
    expect(result).toHaveLength(1)
    expect(result[0]?.groupMatched).toBe(true)
  })

  it('reports the filtered count, not the total', () => {
    const total = countSessions(groups)
    const filtered = countSessions(filterGroups(groups, titleOf, 'migrate'))
    expect(total).toBe(3)
    expect(filtered).toBe(1)
  })
})
