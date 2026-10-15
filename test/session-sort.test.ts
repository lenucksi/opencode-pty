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
    cols: 240,
    rows: 80,
    charCount: 0,
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

describe('sortSessionsByTime and a lost endedAt', () => {
  // `endedAt` is LOST across a restart - that is what `exitAt` exists for. Ordered by
  // `endedAt ?? createdAt`, a restarted session has no end time and falls back to its
  // START, so a session that finished twenty minutes ago sorted ABOVE one that finished
  // a minute ago. Both surfaces were wrong in the same direction, which is the worst kind.
  // The shape that actually distinguishes the two rules: A ENDED after B, but A STARTED
  // before B. Ordered by `endedAt ?? createdAt`, A has no `endedAt` and falls back to its
  // start, so B sorts above it - and the more recently finished session appears further
  // down the list. An earlier version of this case picked two sessions whose start order
  // and end order agreed, so it passed with the old rule too and proved nothing.
  it('prefers exitAt over endedAt, so a restarted session sorts where it finished', () => {
    const endedLater = session('ended-later', {
      status: 'exited',
      exitCode: 0,
      createdAt: '2026-09-21T10:00:00.000Z',
      exitAt: '2026-09-21T10:20:00.000Z',
    })
    const startedLater = session('started-later', {
      status: 'exited',
      exitCode: 0,
      createdAt: '2026-09-21T10:10:00.000Z',
      exitAt: '2026-09-21T10:15:00.000Z',
    })
    // Both sessions carry no `endedAt`, which is exactly the restart case.
    expect(endedLater.endedAt).toBeUndefined()
    expect(startedLater.endedAt).toBeUndefined()
    expect(sortSessionsByTime([startedLater, endedLater]).map((s) => s.id)).toEqual([
      'ended-later',
      'started-later',
    ])
  })

  // The fallback chain still exists, for the case that made `endedAt` necessary: a session
  // killed by a request never wrote `exitAt`, because `kill(id, cleanup = true)` deletes
  // the record instead of re-archiving it.
  it('falls back to endedAt, then to createdAt', () => {
    const onlyEnded = session('only-ended', {
      status: 'exited',
      createdAt: '2026-09-21T10:00:00.000Z',
      endedAt: '2026-09-21T10:40:00.000Z',
    })
    const running = session('running', { createdAt: '2026-09-21T10:50:00.000Z' })
    expect(sortSessionsByTime([onlyEnded, running]).map((s) => s.id)).toEqual([
      'running',
      'only-ended',
    ])
  })
})
