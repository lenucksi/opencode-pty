import { afterAll, describe, expect, it } from 'bun:test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import { OutputManager } from '../src/plugin/pty/output-manager.ts'
import { applyLineBudget } from '../src/plugin/pty/read-budget.ts'
import { SessionStore } from '../src/plugin/pty/session-store.ts'
import type { PTYSession, PTYSessionInfo } from '../src/plugin/pty/types.ts'

/**
 * The read budget replaced a per-line clamp that appended a bare `...`.
 *
 * That clamp had two failures worth guarding. It destroyed the information at
 * the return type, so a cut line was indistinguishable from a line that really
 * ended there; and because `hasMore` was pure line arithmetic, a line cut in
 * half on the last line of a read still reported "end of buffer". Both are
 * regressions, not preferences, so both are tested.
 */

/** A session is only ever its buffer as far as the read path is concerned. */
function sessionWith(text: string): PTYSession {
  const buffer = new RingBuffer()
  buffer.append(text)
  return { buffer } as PTYSession
}

describe('applyLineBudget', () => {
  it('delivers whole lines untouched while they fit', () => {
    const result = applyLineBudget(['abc', 'de', 'f'], 10, () => null)

    expect(result.lines).toEqual(['abc', 'de', 'f'])
    expect(result.consumedChars).toBe(6)
    expect(result.truncatedLines).toBe(0)
    expect(result.cutIndex).toBeNull()
    expect(result.nextSince).toBeNull()
  })

  it('cuts at most one line and no earlier than it has to', () => {
    // 3 + 2 fill the budget exactly, so the third line is the first that cannot
    // fit. Stopping one line earlier would waste budget on every single call.
    const result = applyLineBudget(['abc', 'de', 'fghij'], 5, () => null)

    expect(result.lines).toEqual(['abc', 'de'])
    expect(result.consumedChars).toBe(5)
    // Nothing of the third line was delivered, so it is still a line that was
    // cut. Reporting zero here would let a reader conclude the buffer ended.
    expect(result.truncatedLines).toBe(1)
    expect(result.cutIndex).toBe(2)
  })

  it('reports the cut line and the offset to resume from', () => {
    const result = applyLineBudget(['abc', 'de', 'fghij'], 6, (index) => index * 3)

    expect(result.truncatedLines).toBe(1)
    expect(result.cutIndex).toBe(2)
    expect(result.slices.at(-1)).toEqual({
      text: 'f',
      shownChars: 1,
      totalChars: 5,
      truncated: true,
    })
    // Line 2 starts at absolute offset 6; one character of it was delivered.
    expect(result.nextSince).toBe(7)
  })

  it('adds no empty slice when the budget ran out before the cut line', () => {
    // The budget is spent exactly by the first line, so the second cannot start.
    const result = applyLineBudget(['abc', 'de'], 3, () => 3)

    expect(result.lines).toEqual(['abc'])
    // An empty trailing line in the output would be indistinguishable from a
    // blank line the process actually printed.
    expect(result.slices).toHaveLength(1)
    // Still a cut: line 1 exists and was not delivered.
    expect(result.truncatedLines).toBe(1)
    expect(result.cutIndex).toBe(1)
    expect(result.nextSince).toBe(3)
  })

  it('handles a zero budget without producing a negative slice', () => {
    const result = applyLineBudget(['abc'], 0, () => 0)

    expect(result.slices).toEqual([])
    expect(result.consumedChars).toBe(0)
    expect(result.truncatedLines).toBe(1)
  })

  it('leaves the input untouched', () => {
    const lines = ['abcdef']
    applyLineBudget(lines, 2, () => 0)
    expect(lines).toEqual(['abcdef'])
  })
})

describe('RingBuffer.lineStartOffset', () => {
  it('points at the first character of the requested line', () => {
    const buffer = new RingBuffer()
    buffer.append('aaa\nbbbb\ncc')

    expect(buffer.lineStartOffset(0)).toBe(0)
    expect(buffer.lineStartOffset(1)).toBe(4)
    expect(buffer.lineStartOffset(2)).toBe(9)
  })

  it('stays absolute after the window has rolled over', () => {
    // A small buffer forces truncation, which shifts startOffset. An offset
    // that restarted at zero here would resume from the wrong place and either
    // duplicate or skip output.
    const buffer = new RingBuffer(20)
    buffer.append('0123456789\n')
    buffer.append('abcdefghij\n')

    expect(buffer.bufferStart).toBeGreaterThan(0)
    const first = buffer.lineStartOffset(0)
    const second = buffer.lineStartOffset(1)
    expect(first).toBe(buffer.bufferStart)
    // The distance between two lines is a property of the data, not of how much
    // of it survived: the first line plus the newline that ended it.
    const firstLineLength = (buffer.read(0, 1)[0] ?? '').length
    expect((second ?? 0) - (first ?? 0)).toBe(firstLineLength + 1)
  })

  it('returns null for a line that does not exist', () => {
    const buffer = new RingBuffer()
    buffer.append('one\ntwo')

    expect(buffer.lineStartOffset(2)).toBeNull()
    expect(buffer.lineStartOffset(99)).toBeNull()
  })
})

describe('OutputManager budgeted read', () => {
  const output = new OutputManager()

  it('reports hasMore when the last line was cut, which line arithmetic missed', () => {
    // One line, longer than the budget. The old check was
    // `offset + lines.length < totalLines`, which is false here, so this read
    // claimed to be the end of the buffer while withholding 95 % of the line.
    const session = sessionWith('x'.repeat(1000))
    const result = output.read(session, 0, undefined, 50)

    expect(result.hasMore).toBe(true)
    expect(result.truncatedLines).toBe(1)
    expect(result.nextSince).toBe(50)
    expect(result.shownChars).toBe(50)
    expect(result.bufferChars).toBe(1000)
  })

  it('reports no more data when the budget delivered everything', () => {
    const session = sessionWith('short line\nanother')
    const result = output.read(session, 0, undefined, 10_000)

    expect(result.hasMore).toBe(false)
    expect(result.truncatedLines).toBe(0)
    expect(result.nextSince).toBeNull()
  })

  it('stops at the first long line instead of clamping every one of them', () => {
    // Five 5000-character lines with a 1000-character budget. The old clamp
    // delivered 2000 characters from each line and ran on through all five,
    // handing back 10000 characters for a 1000-character budget. Only the
    // whole-result cap stops after the first cut.
    const session = sessionWith(Array.from({ length: 5 }, () => 'y'.repeat(5000)).join('\n'))
    const result = output.read(session, 0, undefined, 1000)

    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toHaveLength(1000)
    expect(result.shownChars).toBe(1000)
    expect(result.truncatedLines).toBe(1)
    expect(result.hasMore).toBe(true)
    expect(result.nextSince).toBe(1000)
  })

  it('caps a long multi-line log even though no single line is long', () => {
    // The case the old per-line clamp structurally could not catch: 500 lines of
    // 20 characters are all under the 2000-character line limit, so the clamp
    // delivered every one of them and the result was 4x over budget. Only a cap
    // on the whole result bounds this.
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} of the log`)
    const session = sessionWith(lines.join('\n'))
    const result = output.read(session, 0, undefined, 1000)

    // The budget governs line content, which is what the model pays for. Newlines
    // are free in the budget but are real characters in the delivered stream, so
    // the stream may exceed the budget by at most one newline per delivered line.
    // Anything beyond that would mean the budget is not actually being applied.
    const deliveredLines = result.lines.length
    const newlines = Math.max(0, deliveredLines - 1)
    expect(result.shownChars).toBeGreaterThanOrEqual(1000)
    expect(result.shownChars).toBeLessThanOrEqual(1000 + newlines)
    expect(result.truncatedLines).toBe(1)
    expect(result.hasMore).toBe(true)
    expect(result.nextSince).toBe(result.shownChars)
    expect(result.lines.length).toBeLessThan(500)
  })

  it('still reports hasMore when whole lines remain beyond the window', () => {
    const session = sessionWith('a\nb\nc\nd')
    const result = output.read(session, 0, 2, 10_000)

    expect(result.lines).toEqual(['a', 'b'])
    expect(result.hasMore).toBe(true)
    expect(result.nextSince).toBe(4)
  })

  it('counts a multi-line build log round-trip byte-identically', () => {
    // The case the old clamp got wrong in the other direction: 500 short lines
    // are all delivered, and nothing is lost even though the buffer is full.
    const lines = Array.from({ length: 500 }, (_, i) => `[${i}] build step ok`)
    const source = lines.join('\n')
    const session = sessionWith(source)
    const result = output.read(session, 0, undefined, 10_000)

    expect(result.lines.join('\n')).toBe(source)
    // Stream characters, not line-content characters: the numerator of
    // `chars="X/Y"` has to share a unit with `bufferChars`, or the ratio reads
    // as if 499 characters went missing when nothing was withheld.
    expect(result.shownChars).toBe(source.length)
    expect(result.bufferChars).toBe(source.length)
    expect(result.truncatedLines).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('leaves the archived and the live path agreeing on the cut', async () => {
    // Both readers must classify the same content the same way, or a session
    // that gets archived mid-investigation starts lying about its own output.
    const spawned: string[] = []
    try {
      const session = manager.spawn({
        command: 'printf',
        args: ['%050000d', '7'],
        description: 'budget parity',
        parentSessionId: 'budget-test',
      })
      spawned.push(session.id)

      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        const raw = manager.getRawBuffer(session.id)
        if (raw && raw.raw.length > 10_000) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      const result = manager.read(session.id, 0, undefined, 1000)
      expect(result?.truncatedLines).toBe(1)
      expect(result?.hasMore).toBe(true)
      expect(result?.nextSince).toBe(1000)
    } finally {
      for (const id of spawned) manager.kill(id, true)
      manager.clearAllSessions()
    }
  })
})

describe('archived budget parity', () => {
  const roots: string[] = []
  const stores: SessionStore[] = []

  afterAll(() => {
    for (const store of stores) store.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  /** Archive `output` and return a store that can read it back. */
  function archive(output: string): SessionStore {
    const root = mkdtempSync(join(tmpdir(), 'pty-budget-'))
    roots.push(root)
    const store = new SessionStore({
      root,
      generation: 'budget-test',
      now: () => Date.UTC(2026, 8, 20, 18, 0, 0),
      flushIntervalMs: 1_000_000_000,
    })
    stores.push(store)

    const info: PTYSessionInfo = {
      id: 'pty_archived',
      title: 'archived budget',
      command: 'printf',
      args: ['%s', output],
      workdir: '/tmp',
      status: 'exited',
      notifyOnExit: false,
      timedOut: false,
      pid: 4242,
      createdAt: new Date(Date.UTC(2026, 8, 20, 18, 0, 0)).toISOString(),
      lineCount: output.split('\n').length,
      charCount: output.length,
      cols: 240,
      rows: 80,
    }
    store.startSession(info)
    store.appendOutput(info.id, output)
    store.endSession(info, 0)
    return store
  }

  it('reports a cut archived line instead of claiming the end of the buffer', () => {
    const store = archive('z'.repeat(5000))
    const result = store.read('pty_archived', 0, undefined, 800)

    expect(result?.truncatedLines).toBe(1)
    expect(result?.hasMore).toBe(true)
    expect(result?.nextSince).toBe(800)
    expect(result?.slices[0]?.text).toHaveLength(800)
    expect(result?.slices[0]?.totalChars).toBe(5000)
  })

  it('pages an archived line back to the exact original', () => {
    // `SessionStore.read` is line-paginated, so the character cursor has to be
    // exercised where it actually lives for archived data: `manager.readSince`,
    // which falls through to the store when nothing is live. Driven through the
    // manager's own store so the test does not have to swap global state.
    const source = `${'q'.repeat(3000)}\n`
    const store = manager.getSessionStore()
    const info: PTYSessionInfo = {
      id: 'pty_archived_cursor',
      title: 'archived cursor',
      command: 'printf',
      args: ['%s', source],
      workdir: '/tmp',
      status: 'exited',
      notifyOnExit: false,
      timedOut: false,
      pid: 4243,
      createdAt: new Date(Date.UTC(2026, 8, 20, 18, 0, 0)).toISOString(),
      lineCount: 1,
      cols: 240,
      rows: 80,
      charCount: source.length,
    }
    store.startSession(info)
    store.appendOutput(info.id, source)
    store.endSession(info, 0)

    const parts: string[] = []
    let cursor: number | null = 0
    let guard = 0
    while (cursor !== null) {
      const part = manager.readSince(info.id, cursor, 700)
      if (part === null) throw new Error('archived session vanished mid-page')
      parts.push(part.text)
      cursor = part.nextSince
      if (++guard > 100) throw new Error('archived paging did not terminate')
    }
    expect(parts.join('')).toBe(source)
  })

  it('counts an archived multi-line transcript the same way as a live one', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `archived line ${i}`)
    const store = archive(lines.join('\n'))

    const result = store.read('pty_archived', 0, undefined, 10_000)
    const live = new OutputManager().read(sessionWith(lines.join('\n')), 0, undefined, 10_000)

    expect(result?.lines).toEqual(lines)
    expect(result?.hasMore).toBe(live?.hasMore)
    expect(result?.truncatedLines).toBe(live?.truncatedLines)
    expect(result?.nextSince).toBe(live?.nextSince)
  })
})

describe('character-cursor paging', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  /** Spawn a session and wait until its buffer holds `chars` characters. */
  async function sessionWithAtLeast(chars: number, args: string[]): Promise<string> {
    const session = manager.spawn({
      command: 'printf',
      args,
      description: 'cursor paging',
      parentSessionId: 'budget-test',
    })
    spawned.push(session.id)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const raw = manager.getRawBuffer(session.id)
      if (raw && raw.raw.length >= chars) return session.id
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Timed out waiting for ${chars} chars from ${session.id}`)
  }

  /** Follow nextSince until it is gone, reassembling the stream. */
  function drain(id: string, chunk: number): string {
    const parts: string[] = []
    let cursor: number | null = 0
    let guard = 0
    while (cursor !== null) {
      const part = manager.readSince(id, cursor, chunk)
      if (part === null) throw new Error(`no result for ${id} at ${cursor}`)
      parts.push(part.text)
      cursor = part.nextSince
      if (++guard > 1000) throw new Error('paging did not terminate')
    }
    return parts.join('')
  }

  it('reassembles a single long line exactly across three chunks', async () => {
    // The case that made the old clamp unrecoverable: there is exactly one line,
    // so no line offset can express "continue from here".
    const id = await sessionWithAtLeast(5000, ['%050000d\n', '3'])

    const first = manager.readSince(id, 0, 2000)
    expect(first?.truncated).toBe(true)
    expect(first?.nextSince).toBe(2000)

    const assembled = drain(id, 2000)
    const source = manager.getRawBuffer(id)?.raw ?? ''
    expect(assembled).toBe(source)
    expect(assembled.length).toBeGreaterThan(5000)
  })

  it('reassembles a multi-line build log byte-identically', async () => {
    const id = await sessionWithAtLeast(2000, [
      '%s\n',
      Array.from({ length: 200 }, (_, i) => `step ${i} complete`).join('\n'),
    ])

    const source = manager.getRawBuffer(id)?.raw ?? ''
    expect(drain(id, 700)).toBe(source)
  })

  it('reassembles output containing multi-byte characters', async () => {
    // Offsets are characters, not UTF-8 bytes. If they were conflated, every
    // non-ASCII character would shift the cursor and the tail would be garbled.
    const id = await sessionWithAtLeast(1500, ['%s\n', 'äöüß✓'.repeat(400)])

    const source = manager.getRawBuffer(id)?.raw ?? ''
    expect(drain(id, 301)).toBe(source)
  })

  it('reports no cursor on the final chunk so paging terminates', async () => {
    const id = await sessionWithAtLeast(3, ['%s\n', 'abc'])

    const result = manager.readSince(id, 0, 1_000_000)
    expect(result?.truncated).toBe(false)
    expect(result?.nextSince).toBeNull()
    expect(result?.shownChars).toBe(result?.totalChars)
  })

  it('clamps a cursor from before the retained window', async () => {
    const id = await sessionWithAtLeast(5, ['%s\n', 'hello'])

    // A negative or stale cursor must not throw or return nothing useful.
    const before = manager.readSince(id, -50, 10)
    const after = manager.readSince(id, 0, 10)
    expect(before?.since).toBe(0)
    expect(after?.since).toBe(0)
  })
})

describe('the core invariant', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  it('two reads in different application states are never byte-identical', async () => {
    // The failure this whole change exists to prevent: a reader polls, gets a
    // result, and cannot tell whether the process is still producing output or
    // the tool is showing it a stale cut. If the two states render identically,
    // a frozen TUI and a live one are indistinguishable.
    const session = manager.spawn({
      command: 'sh',
      args: ['-c', 'echo first; sleep 0.4; echo second; sleep 0.4; echo third'],
      description: 'state invariant',
      parentSessionId: 'budget-test',
    })
    spawned.push(session.id)

    const first = manager.read(session.id, 0, undefined, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 900))
    const second = manager.read(session.id, 0, undefined, 10_000)

    const render = (result: typeof first): string => (result?.lines ?? []).join('\n')
    expect(render(first)).not.toBe(render(second))
    expect(render(second)).toContain('third')
    expect(second?.hasMore).toBe(false)
  })
})
