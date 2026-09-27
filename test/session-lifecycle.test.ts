import { describe, expect, it, afterEach } from 'bun:test'
import { SessionLifecycleManager } from '../src/plugin/pty/session-lifecycle.ts'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../src/plugin/constants.ts'

describe('SessionLifecycleManager spawn geometry', () => {
  const manager = new SessionLifecycleManager()
  const spawnedIds: string[] = []

  function spawnSession(cols?: number, rows?: number): string {
    const session = manager.spawn(
      {
        command: 'bash',
        args: [],
        description: 'geometry test session',
        parentSessionId: 'test',
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
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

  it('starts a headless session wide enough for real output', () => {
    // 120x40 was too narrow for anything that prints a table or a full-screen
    // UI, and the output never said why it was wrapping.
    const id = spawnSession()

    expect(manager.getSession(id)?.cols).toBe(FALLBACK_TERMINAL_COLS)
    expect(manager.getSession(id)?.rows).toBe(FALLBACK_TERMINAL_ROWS)
    expect(manager.getSession(id)?.process?.cols).toBe(FALLBACK_TERMINAL_COLS)
    expect(manager.getSession(id)?.process?.rows).toBe(FALLBACK_TERMINAL_ROWS)
  })

  it('honours an explicit size and gives it to the process, not just the record', () => {
    const id = spawnSession(100, 30)

    expect(manager.getSession(id)?.process?.cols).toBe(100)
    expect(manager.getSession(id)?.process?.rows).toBe(30)
  })

  it('fills in only the dimension that was left out', () => {
    const id = spawnSession(100, undefined)

    expect(manager.getSession(id)?.cols).toBe(100)
    expect(manager.getSession(id)?.rows).toBe(FALLBACK_TERMINAL_ROWS)
  })

  it('clamps an absurd request instead of handing it to the PTY', () => {
    const id = spawnSession(999_999, 0)

    expect(manager.getSession(id)?.cols).toBe(MAX_TERMINAL_COLS)
    expect(manager.getSession(id)?.rows).toBe(MIN_TERMINAL_ROWS)
  })

  it('reports the size it is running at, not the one it was asked for', () => {
    const id = spawnSession(100, 30)
    const session = manager.getSession(id)
    const info = session ? manager.toInfo(session) : null

    expect(info?.cols).toBe(100)
    expect(info?.rows).toBe(30)
  })

  it('updates the reported size after a resize', () => {
    const id = spawnSession()
    expect(manager.resize(id, 90, 25)).toBe(true)

    const session = manager.getSession(id)
    const info = session ? manager.toInfo(session) : null
    expect(info?.cols).toBe(90)
    expect(info?.rows).toBe(25)
  })

  it('reports the clamped size, so a caller can see it was not honoured', () => {
    const id = spawnSession()
    manager.resize(id, 5_000, 20)

    const session = manager.getSession(id)
    const info = session ? manager.toInfo(session) : null
    expect(info?.cols).toBe(MAX_TERMINAL_COLS)
  })
})

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

  it('keeps the current size for non-finite dimensions', () => {
    // Falling back to a global default here meant a client sending one bad
    // dimension silently reset the other axis to a size nobody asked for.
    const id = spawnSession()
    expect(manager.resize(id, 100, 30)).toBe(true)

    expect(manager.resize(id, Number.NaN, Number.POSITIVE_INFINITY)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(100)
    expect(session?.process?.rows).toBe(30)
  })

  it('leaves an omitted dimension alone', () => {
    const id = spawnSession()
    expect(manager.resize(id, 100, 30)).toBe(true)

    expect(manager.resize(id, 120)).toBe(true)
    const session = manager.getSession(id)
    expect(session?.process?.cols).toBe(120)
    expect(session?.process?.rows).toBe(30)
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
