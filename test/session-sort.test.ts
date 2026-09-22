import { describe, expect, it } from 'bun:test'

import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { sortSessionsByTime } from '../src/web/shared/session-meta.ts'

function session(id: string, overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id,
    title: id,
    command: 'bash',
    args: [],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 1,
    createdAt: '2026-09-21T15:00:00.000Z',
    lineCount: 0,
    ...overrides,
  }
}

describe('sortSessionsByTime', () => {
  it('puts the newest start first', () => {
    const sorted = sortSessionsByTime([
      session('old', { createdAt: '2026-09-21T10:00:00.000Z' }),
      session('new', { createdAt: '2026-09-21T16:00:00.000Z' }),
      session('mid', { createdAt: '2026-09-21T13:00:00.000Z' }),
    ])

    expect(sorted.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('orders finished sessions by when they ended', () => {
    // Started long ago but finished most recently: it belongs on top.
    const sorted = sortSessionsByTime([
      session('older-end', {
        status: 'exited',
        createdAt: '2026-09-21T15:40:00.000Z',
        endedAt: '2026-09-21T15:45:00.000Z',
      }),
      session('recent-end', {
        status: 'exited',
        createdAt: '2026-09-21T09:00:00.000Z',
        endedAt: '2026-09-21T16:00:00.000Z',
      }),
    ])

    expect(sorted.map((s) => s.id)).toEqual(['recent-end', 'older-end'])
  })

  it('keeps a running session above an older finished one', () => {
    const sorted = sortSessionsByTime([
      session('finished', {
        status: 'exited',
        createdAt: '2026-09-21T15:00:00.000Z',
        endedAt: '2026-09-21T15:05:00.000Z',
      }),
      session('running', { createdAt: '2026-09-21T15:30:00.000Z' }),
    ])

    expect(sorted.map((s) => s.id)).toEqual(['running', 'finished'])
  })

  it('is stable for identical timestamps', () => {
    const sorted = sortSessionsByTime([session('b'), session('a')])
    expect(sorted.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
