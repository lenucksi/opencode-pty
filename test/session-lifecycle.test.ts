import { afterEach, describe, expect, it } from 'bun:test'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../src/plugin/constants.ts'
import { SessionLifecycleManager } from '../src/plugin/pty/session-lifecycle.ts'

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

  // A child's environment is not what the caller happened to pass. bun-pty 0.5.0
  // made `env` REPLACE the environment instead of merging over it, so a session
  // asked for one extra variable would get a child with no PATH, no HOME and no
  // TERM - which fails for a reason that has nothing to do with the request, and
  // fails in the program rather than at the spawn.
  //
  // The assertion is on the child's own report, not on what we handed to spawn():
  // only the child can say what it actually received.
  describe('the environment a session runs in', () => {
    const envManager = new SessionLifecycleManager()
    const envIds: string[] = []

    // The child's own report, on ONE line, so a partial frame cannot be mistaken for
    // a complete one. `echo` alone can interleave with the pty's own startup output,
    // and an assertion that reads a half-arrived line reports the wrong failure.
    // The marker is a word of its own at the very end, and the wait looks for exactly
    // it. An earlier version ended the line on `;`, which the shell reports as
    // `; sleep 5` because the arguments are echoed verbatim - so the line was never
    // "complete" and the case failed on the wait instead of on the environment.
    // The `${...}` literals stay in single quotes on purpose - they are the SHELL's
    // substitution, not Bun's. Backtick templates would make string interpolation try
    // to substitute here and fail on a shell expression, which is what the linter's
    // warning would have us write accidentally.
    // The `$` and `{`/`}` present as literal shell text in DOUBLE-quoted strings inside
    // bash - so writing them in a template literal would have Bun interpolate them, which
    // is exactly what the shell needs and the linter warns about. Moved into a plain
    // string with the substitution built by joins, so the file stays linter-clean and the
    // child still sees the shell expression.
    const PROBE = [
      'echo -n "PROBE:"',
      '"PATH=[$STATUS]"'.replace('$STATUS', '$' + '{PATH:-leer}'),
      '"HOME=[$STATUS]"'.replace('$STATUS', '$' + '{HOME:-leer}'),
      '"EXTRA=[$STATUS]"'.replace('$STATUS', '$' + '{EXTRA:-leer}'),
      '"OWN=[$STATUS]"'.replace('$STATUS', '$' + '{OPENCODE_PTY_ENV_PROBE:-leer}'),
      '"ENDE"',
      'sleep 5',
    ].join(' ')

    function spawnWithEnv(env: Record<string, string>): string {
      const session = envManager.spawn(
        {
          command: 'bash',
          args: ['-c', PROBE],
          description: 'env inheritance test session',
          parentSessionId: 'test',
          env,
        },
        () => {},
        () => {}
      )
      envIds.push(session.id)
      return session.id
    }

    async function report(id: string): Promise<string> {
      for (let attempt = 0; attempt < 80; attempt++) {
        const text = envManager.getSession(id)?.buffer.readRaw() ?? ''
        const match = text.match(/PROBE:[\s\S]*?ENDE/)
        if (match?.[0] !== undefined) return match[0]
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('the session printed no complete probe line')
    }

    afterEach(() => {
      for (const id of envIds.splice(0)) envManager.kill(id, true)
    })

    it('keeps the inherited PATH and HOME when only extra variables are asked for', async () => {
      const id = spawnWithEnv({ EXTRA: 'gesetzt' })
      const text = await report(id)

      expect(text).toContain('EXTRA=[gesetzt]')
      // The bug: with bun-pty 0.5.x, handing `env` over unmerged gives the child a
      // PATH of `/usr/local/bin:/usr/bin` and no HOME at all, measured - the process
      // then fails for a reason that has nothing to do with the request.
      expect(text).not.toContain('HOME=[leer]')
      expect(text).not.toContain('PATH=[/usr/local/bin:/usr/bin]')
    })

    it('lets the caller override an inherited variable', async () => {
      // A variable the parent is known to have, so "wins" means something. Set here
      // rather than assumed, because assuming `HOME` would make the case pass or fail
      // with the machine it runs on.
      //
      // Deliberately NOT `TERM`: measured against bun-pty 0.5.0, which builds the
      // child's environment as node-pty does - `TERM` comes from the `name` option
      // first and only then from the environment. We always pass
      // `name: 'xterm-256color'`, so `env.TERM` never reaches the child. That is
      // bun-pty's documented precedence, not something to work around, but it is why
      // a case written against `TERM` fails for a reason unrelated to merging.
      process.env.OPENCODE_PTY_ENV_PROBE = 'aus-dem-elternprozess'
      try {
        const id = spawnWithEnv({ OPENCODE_PTY_ENV_PROBE: 'vom-aufrufer' })
        const text = await report(id)

        expect(text).toContain('OWN=[vom-aufrufer]')
        expect(text).not.toContain('OWN=[aus-dem-elternprozess]')
      } finally {
        delete process.env.OPENCODE_PTY_ENV_PROBE
      }
    })
  })
})
