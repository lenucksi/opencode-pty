/**
 * The panel's first look, and why it is not a single try.
 *
 * The setup refresh runs while the server half is still starting, so it usually finds
 * nothing - and the ordinary poll would not ask again for 2.5 s. This burst is the window in
 * between, and the cases here are the three things that must hold: it stops at the first
 * list, it gives up after its attempts, and it never asks for a start.
 *
 * `sleep` is injected, so the whole burst costs nothing in wall-clock time and the counts are
 * exact rather than approximate.
 */

import { describe, expect, it } from 'bun:test'

import {
  FIRST_LOOK_ATTEMPTS,
  FIRST_LOOK_INTERVAL_MS,
  firstLookBurst,
} from '../src/tui/first-look.ts'

interface Harness {
  readonly refreshes: number[]
  readonly slept: number[]
  readonly found: () => boolean
  readonly disposed: () => boolean
  readonly deps: {
    refresh: () => Promise<void>
    found: () => boolean
    disposed: () => boolean
    sleep: (ms: number) => Promise<void>
  }
}

/** A burst that finds its server on refresh number `succeedsOn` (1-based), or never. */
function harness(succeedsOn: number | null): Harness {
  const refreshes: number[] = []
  const slept: number[] = []
  let found = false
  return {
    refreshes,
    slept,
    found: () => found,
    disposed: () => false,
    deps: {
      refresh: async () => {
        refreshes.push(refreshes.length + 1)
        if (succeedsOn !== null && refreshes.length >= succeedsOn) found = true
      },
      found: () => found,
      disposed: () => false,
      sleep: async (ms) => {
        slept.push(ms)
      },
    },
  }
}

describe('firstLookBurst', () => {
  it('stops at the first list', async () => {
    const h = harness(3)
    await firstLookBurst(h.deps)

    expect(h.refreshes).toHaveLength(3)
    expect(h.slept).toEqual([
      FIRST_LOOK_INTERVAL_MS,
      FIRST_LOOK_INTERVAL_MS,
      FIRST_LOOK_INTERVAL_MS,
    ])
  })

  it('does nothing when the setup refresh already found the server', async () => {
    const h = harness(null)
    await firstLookBurst({ ...h.deps, found: () => true })

    expect(h.refreshes).toHaveLength(0)
    expect(h.slept).toHaveLength(0)
  })

  it('gives up after its attempts, so a machine with no server behaves as before', async () => {
    const h = harness(null)
    await firstLookBurst(h.deps)

    expect(h.refreshes).toHaveLength(FIRST_LOOK_ATTEMPTS)
    // The whole burst is a bounded window: attempts x interval, not an open-ended poll.
    expect(h.slept).toHaveLength(FIRST_LOOK_ATTEMPTS)
  })

  it('stops when the plugin is disposed mid-burst', async () => {
    let disposed = false
    const refreshes: number[] = []
    await firstLookBurst(
      {
        refresh: async () => {
          refreshes.push(1)
          disposed = true
        },
        found: () => false,
        disposed: () => disposed,
        sleep: async () => {},
      },
      12,
      1
    )

    expect(refreshes).toHaveLength(1)
  })

  it('asks with no arguments, so it can never start a server', async () => {
    const calls: unknown[][] = []
    await firstLookBurst({
      refresh: async (...args: unknown[]) => {
        calls.push(args)
      },
      found: () => calls.length >= 2,
      disposed: () => false,
      sleep: async () => {},
    })

    // `refresh(mayStart)` is the only way a start is requested; a bare call is a plain list.
    expect(calls).toEqual([[], []])
  })
})
