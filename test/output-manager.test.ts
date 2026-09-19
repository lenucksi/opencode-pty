import { describe, expect, it, mock } from 'bun:test'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import { OutputManager } from '../src/plugin/pty/output-manager.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'

function createSession(content: string, process: PTYSession['process'] = null): PTYSession {
  const buffer = new RingBuffer()
  buffer.append(content)
  return {
    id: 'pty_output',
    title: 'Output session',
    command: 'cat',
    args: [],
    workdir: '/tmp',
    status: 'running',
    pid: 1,
    createdAt: new Date(),
    notifyOnExit: false,
    timeoutSeconds: undefined,
    timedOut: false,
    parentSessionId: 'parent-output',
    buffer,
    process,
  }
}

describe('OutputManager', () => {
  describe('write', () => {
    it('writes through to the underlying process', () => {
      const write = mock((_data: string) => {})
      const output = new OutputManager()

      expect(
        output.write(createSession('', { write } as unknown as PTYSession['process']), 'x')
      ).toBe(true)
      expect(write).toHaveBeenCalledWith('x')
    })

    it('tolerates writing to a session without a process', () => {
      const output = new OutputManager()
      expect(output.write(createSession(''), 'x')).toBe(true)
    })

    it('tolerates a throwing process and still reports success', () => {
      const write = mock((_data: string) => {
        throw new Error('process already exited')
      })
      const output = new OutputManager()

      expect(
        output.write(createSession('', { write } as unknown as PTYSession['process']), 'x')
      ).toBe(true)
    })
  })

  describe('read', () => {
    it('reads the whole buffer by default', () => {
      const output = new OutputManager()
      const result = output.read(createSession('a\nb\nc'))

      expect(result.lines).toEqual(['a', 'b', 'c'])
      expect(result.totalLines).toBe(3)
      expect(result.offset).toBe(0)
      expect(result.hasMore).toBe(false)
    })

    it('paginates and reports hasMore', () => {
      const output = new OutputManager()
      const result = output.read(createSession('a\nb\nc\nd'), 1, 2)

      expect(result.lines).toEqual(['b', 'c'])
      expect(result.offset).toBe(1)
      expect(result.hasMore).toBe(true)
    })

    it('returns an empty page for an empty buffer', () => {
      const output = new OutputManager()
      const result = output.read(createSession(''))

      expect(result.lines).toEqual([])
      expect(result.totalLines).toBe(0)
      expect(result.hasMore).toBe(false)
    })
  })

  describe('search', () => {
    it('returns every match when no limit is supplied', () => {
      const output = new OutputManager()
      const result = output.search(createSession('alpha\nbeta\nalpha two'), /alpha/)

      expect(result.matches).toEqual([
        { lineNumber: 1, text: 'alpha' },
        { lineNumber: 3, text: 'alpha two' },
      ])
      expect(result.totalMatches).toBe(2)
      expect(result.totalLines).toBe(3)
      expect(result.hasMore).toBe(false)
    })

    it('paginates matches and reports hasMore', () => {
      const output = new OutputManager()
      const result = output.search(createSession('a\na\na\na'), /a/, 1, 2)

      expect(result.matches).toEqual([
        { lineNumber: 2, text: 'a' },
        { lineNumber: 3, text: 'a' },
      ])
      expect(result.totalMatches).toBe(4)
      expect(result.hasMore).toBe(true)
    })

    it('returns no matches for an empty buffer', () => {
      const output = new OutputManager()
      const result = output.search(createSession(''), /x/)

      expect(result.matches).toEqual([])
      expect(result.totalMatches).toBe(0)
      expect(result.hasMore).toBe(false)
    })
  })
})
