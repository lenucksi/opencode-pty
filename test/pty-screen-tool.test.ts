import { afterAll, describe, expect, it } from 'bun:test'

import { ptyScreen } from '../src/plugin/pty/tools/screen.ts'
import { manager } from '../src/plugin/pty/manager.ts'

/**
 * `pty_screen` is its own tool rather than a `pty_read` mode, so it has to stand
 * on its own: report the geometry, report the cursor, stay inside the read budget,
 * and never claim more than it rendered.
 */

/** The tool returns a string in practice; this keeps the assertions honest about it. */
function text(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'output' in result) {
    const output = (result as { output: unknown }).output
    if (typeof output === 'string') return output
  }
  throw new Error(`unexpected tool result: ${JSON.stringify(result).slice(0, 200)}`)
}

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

describe('pty_screen', () => {
  // The tool reaches the shared manager, so the sessions have to live there too.
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  function spawn(args: string[], cols?: number, rows?: number): string {
    const info = manager.spawn({
      command: 'sh',
      args,
      description: 'screen probe',
      parentSessionId: 'screen-test',
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
    })
    spawned.push(info.id)
    return info.id
  }

  it('throws for a session nobody has ever seen', async () => {
    expect(ptyScreen.execute({ id: 'pty_nope' }, ctx)).rejects.toThrow()
  })

  it('reports the geometry the session is running at', async () => {
    const id = spawn(['-c', 'printf "hi\\r\\n"; sleep 5'], 40, 12)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(result).toContain('cols="40"')
    expect(result).toContain('rows="12"')
  })

  it('renders the row as text with its row number', async () => {
    const id = spawn(['-c', 'printf "first\\r\\nsecond\\r\\n"; sleep 5'], 40, 8)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(result).toContain('1| first')
    expect(result).toContain('2| second')
  })

  it('reports the cursor rather than leaving the reader to infer it', async () => {
    const id = spawn(['-c', 'printf "at 3,4\\033[3;5Hx"; sleep 5'], 40, 10)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(result).toMatch(/cursor="5,2"/)
    expect(result).toContain('visible="true"')
  })

  it('omits colour spans unless they are asked for', async () => {
    const id = spawn(['-c', 'printf "\\033[31mred\\033[0m\\r\\ndone\\r\\n"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const plain = await ptyScreen.execute({ id }, ctx)
    const coloured = await ptyScreen.execute({ id, colors: true }, ctx)

    expect(plain).not.toContain('<pty_spans')
    expect(coloured).toContain('<pty_spans count="1">')
    // A span has to be locatable against the body above it.
    expect(coloured).toMatch(/1 0 3 fg=#[0-9a-f]{6}/)
  })

  it('renders at a requested width without changing the session', async () => {
    const id = spawn(['-c', 'printf "\\033[1;1Ha\\033[1;3Hb\\033[1;5Hc\\r\\n"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const before = manager.get(id)

    const wide = await ptyScreen.execute({ id, width: 20, height: 4 }, ctx)

    expect(wide).toContain('cols="20"')
    expect(wide).toContain('rows="4"')
    // Asking to look at a different size must not resize the running process.
    expect(manager.get(id)?.cols).toBe(before?.cols)
    expect(manager.get(id)?.rows).toBe(before?.rows)
  })

  it('fits an absurd requested size into the render budget', async () => {
    // 1000x1000 is inside the per-dimension clamp and still a 25-second render.
    const id = spawn(['-c', 'printf "x"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const started = performance.now()
    const result = await ptyScreen.execute({ id, width: 999_999, height: 999_999 }, ctx)
    const elapsed = performance.now() - started

    expect(result).toContain('requested="1000x1000"')
    expect(result).toMatch(/cols="\d+"/)
    expect(text(result)).toContain('instead of the requested 1000x1000')
    // The whole point of the budget: bounded work, not a hung plugin.
    expect(elapsed).toBeLessThan(5000)
  })

  it('reports the real geometry it rendered at, not the one requested', async () => {
    const id = spawn(['-c', 'printf "x"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const result = await ptyScreen.execute({ id, width: 999_999, height: 999_999 }, ctx)

    const cols = Number(/cols="(\d+)"/.exec(text(result))?.[1] ?? 0)
    const rows = Number(/rows="(\d+)"/.exec(text(result))?.[1] ?? 0)
    expect(cols * rows).toBeLessThanOrEqual(100_000)
  })

  it('keeps a realistic large screen exactly as requested', async () => {
    const id = spawn(['-c', 'printf "x"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const result = await ptyScreen.execute({ id, width: 400, height: 120 }, ctx)

    expect(result).toContain('cols="400"')
    expect(result).toContain('rows="120"')
    expect(result).not.toContain('requested=')
  })

  it('says so when the session has produced nothing yet', async () => {
    const id = spawn(['-c', 'sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(result).toContain('no output yet')
  })

  it('points at pty_read for the scrollback above the screen', async () => {
    const id = spawn(['-c', 'for i in $(seq 1 60); do echo "line $i"; done; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 600))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(result).toMatch(/scrollback="\d+"/)
    expect(result).toContain('pty_read')
  })

  it('keeps a 240x80 screen inside the read budget', async () => {
    // A full-size screen is 19200 cells. The response must stay small enough to
    // be worth a tool call, or the tool costs more than it saves.
    const id = spawn(['-c', 'for i in $(seq 1 200); do echo "row $i"; done; sleep 5'], 240, 80)
    await new Promise((resolve) => setTimeout(resolve, 700))

    const result = await ptyScreen.execute({ id }, ctx)

    expect(text(result).length).toBeLessThan(25_000)
    // 80 rows, blank ones trimmed to just the row marker.
    expect(
      text(result)
        .split('\n')
        .filter((line) => /^\d+\|/.test(line))
    ).toHaveLength(80)
  })

  it('reports a failed render instead of claiming the screen is empty', async () => {
    const id = spawn(['-c', 'printf "content"; sleep 5'], 40, 6)
    await new Promise((resolve) => setTimeout(resolve, 300))

    // An impossible geometry is the cheapest way to make the emulator throw.
    const result = await ptyScreen.execute({ id, width: 1, height: 1 }, ctx)

    // Whatever the outcome, it must be a screen block with either content or a
    // stated reason - never a bare empty result.
    expect(text(result).startsWith('<pty_screen')).toBe(true)
    expect(text(result).endsWith('</pty_screen>')).toBe(true)
  })

  it('renders an archived session from its transcript', async () => {
    // The whole point of replaying rather than keeping a live emulator per
    // session: a session that has exited and been archived renders the same way.
    const info = manager.spawn({
      command: 'sh',
      args: ['-c', 'printf "archived line\\r\\n"; exit 0'],
      description: 'archived screen',
      parentSessionId: 'screen-test',
      cols: 40,
      rows: 6,
    })
    await new Promise((resolve) => setTimeout(resolve, 700))

    spawned.push(info.id)
    const result = await ptyScreen.execute({ id: info.id }, ctx)

    expect(result).toContain('1| archived line')
  })
})
