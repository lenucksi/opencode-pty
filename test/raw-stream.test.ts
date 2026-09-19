import { describe, expect, it } from 'bun:test'
import { RawStream } from '../src/web/client/lib/raw-stream.ts'

describe('RawStream', () => {
  it('seeds from the first chunk and tracks its offset', () => {
    const stream = new RawStream()

    expect(stream.applyChunk({ rawData: 'hello', offset: 0 })).toBe('applied')
    expect(stream.value).toBe('hello')
    expect(stream.offset).toBe(5)

    expect(stream.applyChunk({ rawData: ' world', offset: 5 })).toBe('applied')
    expect(stream.value).toBe('hello world')
    expect(stream.offset).toBe(11)
  })

  it('discards duplicate chunks', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })

    expect(stream.applyChunk({ rawData: 'hello', offset: 0 })).toBe('duplicate')
    expect(stream.applyChunk({ rawData: 'llo', offset: 2 })).toBe('duplicate')
    expect(stream.value).toBe('hello')
    expect(stream.offset).toBe(5)
  })

  it('applies only the non-overlapping suffix of a partially duplicated chunk', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })

    expect(stream.applyChunk({ rawData: 'lo world', offset: 3 })).toBe('applied')
    expect(stream.value).toBe('hello world')
    expect(stream.offset).toBe(11)
  })

  it('detects gaps so the caller can resync', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })

    expect(stream.applyChunk({ rawData: 'world', offset: 10 })).toBe('gap')
    expect(stream.value).toBe('hello')
    expect(stream.offset).toBe(5)
  })

  it('merges a snapshot fetched after subscribing without losing or duplicating output', () => {
    const stream = new RawStream()

    // A chunk produced before the snapshot request was seeded mid-stream.
    stream.applyChunk({ rawData: 'BBB', offset: 3 })
    expect(stream.start).toBe(3)

    // Snapshot covers 0..8 and overlaps the chunk we already have.
    stream.applySnapshot({ raw: 'AAABBBCC', offset: 0 })

    expect(stream.value).toBe('AAABBBCC')
    expect(stream.start).toBe(0)
    expect(stream.offset).toBe(8)
  })

  it('ignores a snapshot that is already fully covered', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello world', offset: 0 })
    stream.applySnapshot({ raw: 'hello', offset: 0 })

    expect(stream.value).toBe('hello world')
    expect(stream.offset).toBe(11)
  })

  it('resyncs from a snapshot that starts beyond the rendered stream', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })
    stream.applySnapshot({ raw: 'world', offset: 10 })

    expect(stream.value).toBe('world')
    expect(stream.offset).toBe(15)
  })

  it('seeds from a snapshot when no chunks have arrived yet', () => {
    const stream = new RawStream()

    stream.applySnapshot({ raw: 'snapshot', offset: 100 })

    expect(stream.value).toBe('snapshot')
    expect(stream.offset).toBe(108)
    expect(stream.initialized).toBe(true)
  })

  it('reset clears all state', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 4 })
    stream.reset()

    expect(stream.value).toBe('')
    expect(stream.offset).toBe(0)
    expect(stream.initialized).toBe(false)
  })

  it('backfills a prefix chunk that starts before the rendered window', () => {
    const stream = new RawStream()

    // Seed mid-stream, then receive a chunk that also covers the missing head.
    stream.applyChunk({ rawData: ' worl', offset: 5 })
    expect(stream.start).toBe(5)
    expect(stream.render).toEqual({ type: 'append', data: ' worl' })

    expect(stream.applyChunk({ rawData: 'hello world', offset: 0 })).toBe('applied')
    expect(stream.value).toBe('hello world')
    expect(stream.start).toBe(0)
    expect(stream.offset).toBe(11)
    expect(stream.render).toEqual({ type: 'rewrite', data: 'hello world' })
  })

  it('appends only the suffix of a snapshot that extends past the window', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'abc', offset: 0 })
    stream.applySnapshot({ raw: 'abcde', offset: 0 })

    expect(stream.value).toBe('abcde')
    expect(stream.offset).toBe(5)
    expect(stream.render).toEqual({ type: 'append', data: 'de' })
  })

  it('produces a rewrite when the snapshot backfills the head', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'cde', offset: 2 })
    stream.applySnapshot({ raw: 'abcde', offset: 0 })

    expect(stream.value).toBe('abcde')
    expect(stream.render).toEqual({ type: 'rewrite', data: 'abcde' })
  })

  it('exposes a none render intent when nothing changes', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })
    expect(stream.applyChunk({ rawData: 'hello', offset: 0 })).toBe('duplicate')
    expect(stream.render).toEqual({ type: 'none' })

    expect(stream.applyChunk({ rawData: 'world', offset: 99 })).toBe('gap')
    expect(stream.render).toEqual({ type: 'none' })

    stream.applySnapshot({ raw: 'hello', offset: 0 })
    expect(stream.render).toEqual({ type: 'none' })
  })

  it('reports the reset render intent after reset', () => {
    const stream = new RawStream()

    stream.applyChunk({ rawData: 'hello', offset: 0 })
    stream.reset()

    expect(stream.render).toEqual({ type: 'reset' })
  })

  it('marks itself initialized only after the first chunk or snapshot', () => {
    const stream = new RawStream()
    expect(stream.initialized).toBe(false)

    stream.applyChunk({ rawData: 'hello', offset: 0 })
    expect(stream.initialized).toBe(true)

    const snapshotStream = new RawStream()
    snapshotStream.applySnapshot({ raw: 'snapshot', offset: 0 })
    expect(snapshotStream.initialized).toBe(true)
  })
})
