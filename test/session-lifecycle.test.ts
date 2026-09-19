import { describe, expect, it, afterEach } from 'bun:test'
import { SessionLifecycleManager } from '../src/plugin/pty/session-lifecycle.ts'
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../src/plugin/constants.ts'

describe('SessionLifecycleManager.resize', () => {
  const manager = new SessionLifecycleManager()
  const spawnedIds: string[] = []

  function spawnSession(): string {
    const session = manager.spawn(
      {
        command: 'bash',
        args: [],
        description: 'resize test session',
        parentSessionId: 'test',
      },
      () => {},
      () => {}
    )
    spawnedIds.push(session.id)
    return session.id
  }

  afterEach(() => {
    for (const id of spawnedIds.splice(0)) {
      manager.kill(id, true)
    }
  })

  it('applies valid dimensions to the PTY process', () => {
    const id = spawnSession()

    expect(manager.resize(id, 80, 24)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(80)
    expect(session?.process?.rows).toBe(24)
  })

  it('clamps zero and negative dimensions to the minimum', () => {
    const id = spawnSession()

    expect(manager.resize(id, 0, -5)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(MIN_TERMINAL_COLS)
    expect(session?.process?.rows).toBe(MIN_TERMINAL_ROWS)
  })

  it('clamps huge dimensions to the maximum', () => {
    const id = spawnSession()

    expect(manager.resize(id, 100_000, 100_000)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(MAX_TERMINAL_COLS)
    expect(session?.process?.rows).toBe(MAX_TERMINAL_ROWS)
  })

  it('falls back to defaults for non-finite dimensions', () => {
    const id = spawnSession()

    expect(manager.resize(id, Number.NaN, Number.POSITIVE_INFINITY)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(DEFAULT_TERMINAL_COLS)
    expect(session?.process?.rows).toBe(DEFAULT_TERMINAL_ROWS)
  })

  it('floors fractional dimensions', () => {
    const id = spawnSession()

    expect(manager.resize(id, 80.9, 24.9)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(80)
    expect(session?.process?.rows).toBe(24)
  })

  it('is a no-op for unknown sessions', () => {
    expect(manager.resize('pty_does_not_exist', 80, 24)).toBe(false)
  })
})
