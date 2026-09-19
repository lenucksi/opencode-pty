import { describe, expect, it } from 'bun:test'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'

describe('RingBuffer', () => {
  describe('offsets', () => {
    it('returns the start offset of each appended chunk', () => {
      const buffer = new RingBuffer(100)

      expect(buffer.append('abc')).toBe(0)
      expect(buffer.append('def')).toBe(3)
      expect(buffer.append('')).toBe(6)
      expect(buffer.append('ghi')).toBe(6)

      expect(buffer.bufferStart).toBe(0)
      expect(buffer.bufferEnd).toBe(9)
      expect(buffer.readRaw()).toBe('abcdefghi')
    })

    it('keeps offsets monotonic across truncation', () => {
      const buffer = new RingBuffer(5)

      expect(buffer.append('abcdef')).toBe(0)
      // 'abcdef' -> overflow 1 -> drops 'a'
      expect(buffer.bufferStart).toBe(1)
      expect(buffer.bufferEnd).toBe(6)
      expect(buffer.readRaw()).toBe('bcdef')

      expect(buffer.append('ghi')).toBe(6)
      // 'bcdefghi' -> overflow 3 -> drops 'bcd'
      expect(buffer.bufferStart).toBe(4)
      expect(buffer.bufferEnd).toBe(9)
      expect(buffer.readRaw()).toBe('efghi')
    })
  })

  describe('line count', () => {
    it('maintains an accurate O(1) line count', () => {
      const buffer = new RingBuffer(1000)

      expect(buffer.length).toBe(0)
      expect(buffer.append('a\nb\nc')).toBe(0)
      expect(buffer.length).toBe(3)

      buffer.append('\nd')
      expect(buffer.length).toBe(4)

      buffer.append('')
      expect(buffer.length).toBe(4)
      expect(buffer.read()).toEqual(['a', 'b', 'c', 'd'])
    })

    it('keeps the line count consistent after truncation', () => {
      const buffer = new RingBuffer(5)
      buffer.append('a\nb\nc\nd')

      // 'a\nb\nc\nd' -> overflow 2 -> drops 'a\n'
      expect(buffer.readRaw()).toBe('b\nc\nd')
      expect(buffer.length).toBe(3)
      expect(buffer.read()).toEqual(['b', 'c', 'd'])
    })

    it('resets the line count on clear', () => {
      const buffer = new RingBuffer(100)
      buffer.append('one\ntwo\n')
      expect(buffer.length).toBe(2)

      buffer.clear()
      expect(buffer.length).toBe(0)
      expect(buffer.bufferStart).toBe(0)
      expect(buffer.bufferEnd).toBe(0)
    })
  })

  describe('truncateSafely', () => {
    it('does not cut an ANSI escape sequence in half', () => {
      const buffer = new RingBuffer(12)
      buffer.append('AB\x1b[31mRED\x1b[0mCD')

      // The naive cut would land inside `ESC[31m`; the safe cut skips past it.
      expect(buffer.readRaw()).toBe('RED\x1b[0mCD')
      expect(buffer.bufferStart).toBe(7)
    })

    it('never splits a UTF-16 surrogate pair', () => {
      const emoji = '\u{1F600}' // two UTF-16 code units
      const buffer = new RingBuffer(4)
      buffer.append(`ABC${emoji}DEF`)

      // The naive cut would land between the surrogates, so the emoji is dropped whole.
      expect(buffer.readRaw()).toBe('DEF')
      expect(buffer.bufferStart).toBe(5)

      // Verify no lone surrogate survived in the retained buffer.
      const raw = buffer.readRaw()
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = raw.charCodeAt(i + 1)
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
        }
      }
    })

    it('keeps a whole surrogate pair when the cut lands on the high surrogate', () => {
      const emoji = '\u{1F600}'
      const buffer = new RingBuffer(5)
      buffer.append(`ABC${emoji}DEF`)

      // The cut starts on the high surrogate, which is a safe boundary.
      expect(buffer.readRaw()).toBe(`${emoji}DEF`)
      expect(buffer.bufferStart).toBe(3)
    })

    it('drops a whole pair when maxSize cannot hold it without splitting', () => {
      const buffer = new RingBuffer(1)
      buffer.append('\u{1F600}')

      // Retaining a single code unit would leave a lone surrogate, so drop it all.
      expect(buffer.readRaw()).toBe('')
      expect(buffer.bufferStart).toBe(2)
      expect(buffer.length).toBe(0)
    })
  })

  describe('sliceSince', () => {
    it('returns the suffix after an offset', () => {
      const buffer = new RingBuffer(100)
      buffer.append('hello')
      buffer.append(' world')

      expect(buffer.sliceSince(0)).toEqual({ raw: 'hello world', offset: 0 })
      expect(buffer.sliceSince(6)).toEqual({ raw: 'world', offset: 6 })
      expect(buffer.sliceSince(11)).toEqual({ raw: '', offset: 11 })
    })

    it('clamps offsets outside the retained window', () => {
      const buffer = new RingBuffer(100)
      buffer.append('hello world')

      expect(buffer.sliceSince(-5)).toEqual({ raw: 'hello world', offset: 0 })
      expect(buffer.sliceSince(1000)).toEqual({ raw: '', offset: 11 })
    })

    it('clamps to the retained window after truncation', () => {
      const buffer = new RingBuffer(5)
      buffer.append('abcdefgh')

      expect(buffer.bufferStart).toBe(3)
      expect(buffer.sliceSince(0)).toEqual({ raw: 'defgh', offset: 3 })
      expect(buffer.sliceSince(5)).toEqual({ raw: 'fgh', offset: 5 })
      expect(buffer.sliceSince(8)).toEqual({ raw: '', offset: 8 })
    })
  })

  describe('performance', () => {
    it('scales linearly for >= 1MB of output', () => {
      const buffer = new RingBuffer(100_000)
      const chunk = `${'x'.repeat(999)}\n` // 1000 chars, one newline per chunk
      const iterations = 1200 // 1.2 MB total

      const startedAt = performance.now()
      for (let i = 0; i < iterations; i++) {
        buffer.append(chunk)
        // Exercise the O(1) line count on the hot path.
        void buffer.length
      }
      const elapsedMs = performance.now() - startedAt

      expect(buffer.bufferEnd).toBe(iterations * chunk.length)
      expect(buffer.bufferStart).toBe(iterations * chunk.length - buffer.readRaw().length)
      expect(buffer.readRaw().length).toBe(100_000)
      expect(buffer.length).toBe(100)
      expect(elapsedMs).toBeLessThan(10000)
    }, 30000)
  })
})
