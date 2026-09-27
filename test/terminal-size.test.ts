import { afterAll, describe, expect, it, spyOn } from 'bun:test'

import { ptyResize } from '../src/plugin/pty/tools/resize.ts'
import { manager, PTYManager } from '../src/plugin/pty/manager.ts'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../src/plugin/constants.ts'

/**
 * The terminal size used to be a constant nobody could see.
 *
 * `spawnProcess` passed 120x40 to every PTY, `manager.resize` handed the new
 * geometry to the process and threw the numbers away, and `PTYSessionInfo`
 * carried no size at all. So an agent running a full-screen program could not
 * learn what geometry it had been given, could not change it, and could not tell
 * a cramped program from a broken one.
 */

const ctx = {
  sessionID: 'parent',
  messageID: 'msg',
  agent: 'agent',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  directory: '/tmp',
  worktree: '/tmp',
}

describe('terminal geometry at spawn', () => {
  const spawned: string[] = []
  // A dedicated instance: the exported singleton is shared with every other test
  // file, and a client size one of them recorded would otherwise decide what this
  // block observes.
  const fresh = new PTYManager()

  afterAll(() => {
    for (const id of spawned) fresh.kill(id, true)
    fresh.clearAllSessions()
  })

  function spawn(cols?: number, rows?: number): string {
    const info = fresh.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'geometry probe',
      parentSessionId: 'geometry-test',
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
    })
    spawned.push(info.id)
    return info.id
  }

  it('falls back to a wide geometry when no client has ever reported one', () => {
    // The manager under test has no client, so this is the headless path.
    expect(fresh.clientSize()).toBeNull()
    const id = spawn()

    const info = fresh.get(id)
    expect(info?.cols).toBe(FALLBACK_TERMINAL_COLS)
    expect(info?.rows).toBe(FALLBACK_TERMINAL_ROWS)
    // The 120x40 the process used to get unconditionally is not what it gets now.
    expect(info?.cols).toBeGreaterThanOrEqual(240)
    expect(info?.rows).toBeGreaterThanOrEqual(80)
  })

  it('gives a later session the size the last client reported', () => {
    // A human is looking at an 100x40 pane. A session the agent starts now should
    // fit that pane, because that is the only honest answer to "how wide would
    // this run".
    fresh.noteClientSize(100, 40)
    const id = spawn()

    expect(fresh.get(id)?.cols).toBe(100)
    expect(fresh.get(id)?.rows).toBe(40)
  })

  it('lets an explicit size win over the client size', () => {
    fresh.noteClientSize(100, 40)
    const id = spawn(200, 60)

    expect(fresh.get(id)?.cols).toBe(200)
    expect(fresh.get(id)?.rows).toBe(60)
  })

  it('ignores a non-finite client size rather than poisoning later spawns', () => {
    // A client that reports garbage must not leave the remembered size broken for
    // every session that starts afterwards.
    fresh.noteClientSize(120, 50)
    const before = fresh.clientSize()

    fresh.noteClientSize(Number.NaN, Number.POSITIVE_INFINITY)

    expect(fresh.clientSize()).toEqual(before)
    const id = spawn()
    const info = fresh.get(id)
    expect(Number.isFinite(info?.cols ?? 0)).toBe(true)
    expect(Number.isFinite(info?.rows ?? 0)).toBe(true)
  })

  it('gives the resolved size to the process, not only to the record', () => {
    fresh.noteClientSize(90, 30)
    const id = spawn()
    const session = fresh.getSession(id)

    expect(session?.process?.cols).toBe(90)
    expect(session?.process?.rows).toBe(30)
  })
})

describe('pty_resize', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  function spawn(): string {
    const info = manager.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'resize probe',
      parentSessionId: 'resize-test',
    })
    spawned.push(info.id)
    return info.id
  }

  it('changes both dimensions and reports what it actually set', async () => {
    const id = spawn()

    const result = await ptyResize.execute({ id, cols: 132, rows: 43 }, ctx)

    expect(result).toContain('<pty_resized')
    expect(result).toContain('cols="132"')
    expect(result).toContain('rows="43"')
    expect(manager.get(id)?.cols).toBe(132)
    expect(manager.getSession(id)?.process?.cols).toBe(132)
  })

  it('leaves an omitted dimension at its current value', async () => {
    const id = spawn()
    await ptyResize.execute({ id, cols: 120, rows: 50 }, ctx)

    const result = await ptyResize.execute({ id, cols: 140 }, ctx)

    expect(manager.get(id)?.cols).toBe(140)
    expect(manager.get(id)?.rows).toBe(50)
    expect(result).toContain('rows="50"')
  })

  it('reports the clamped size rather than echoing the request', async () => {
    const id = spawn()

    const result = await ptyResize.execute({ id, cols: 999_999, rows: 0 }, ctx)

    expect(manager.get(id)?.cols).toBe(MAX_TERMINAL_COLS)
    expect(manager.get(id)?.rows).toBe(MIN_TERMINAL_ROWS)
    // Echoing back the request would let a caller believe it got what it asked for.
    expect(result).toContain(`cols="${MAX_TERMINAL_COLS}"`)
    expect(result).toContain(`rows="${MIN_TERMINAL_ROWS}"`)
  })

  it('says plainly when a resize changes nothing', async () => {
    const id = spawn()
    await ptyResize.execute({ id, cols: 100, rows: 30 }, ctx)

    const result = await ptyResize.execute({ id, cols: 100 }, ctx)

    expect(result).toContain('Unchanged: already 100x30')
  })

  it('refuses a no-op call instead of silently doing nothing', async () => {
    const id = spawn()

    const result = await ptyResize.execute({ id }, ctx)

    expect(result).toContain('Nothing to do')
    expect(result).toContain('Current:')
  })

  it('throws for a session nobody has ever seen', async () => {
    expect(ptyResize.execute({ id: 'pty_nope', cols: 80 }, ctx)).rejects.toThrow()
  })

  it('does not turn an agent resize into the remembered client size', async () => {
    // An agent changing one session's geometry says nothing about the size of a
    // human's window. Conflating the two would make every subsequent spawn
    // inherit whatever the agent last asked for.
    manager.noteClientSize(100, 40)
    const id = spawn()
    await ptyResize.execute({ id, cols: 300, rows: 90 }, ctx)

    expect(manager.clientSize()).toEqual({ cols: 100, rows: 40 })
  })

  it('reports a session that exits between the lookup and the resize', async () => {
    // `manager.get` succeeded, so the session existed a moment ago. Losing it in
    // between is a race, not a caller error, and the answer has to be a
    // not-found rather than a fabricated size.
    const id = spawn()
    // Only the resize loses the race; the lookup before it still succeeds.
    const realResize = manager.resize.bind(manager)
    const resizeSpy = spyOn(manager, 'resize').mockImplementation((target) =>
      target === id ? false : realResize(target)
    )

    expect(ptyResize.execute({ id, cols: 80 }, ctx)).rejects.toThrow()

    resizeSpy.mockRestore()
    // The session itself is untouched, so a retry still works.
    expect(ptyResize.execute({ id, cols: 80 }, ctx)).resolves.toContain('cols="80"')
  })

  it('warns that a program may not react to a runtime resize', async () => {
    const id = spawn()

    const result = await ptyResize.execute({ id, cols: 80, rows: 24 }, ctx)

    expect(result).toContain('read its size at startup')
  })
})
