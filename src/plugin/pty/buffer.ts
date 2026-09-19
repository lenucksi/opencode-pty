// Default buffer size in characters (approximately 1MB)
const DEFAULT_MAX_BUFFER_SIZE = parseInt(process.env.PTY_MAX_BUFFER_SIZE || '1000000', 10)

// Bounded window used when inspecting the truncation boundary for ANSI escapes.
// Escape sequences are short in practice; the bound keeps truncation O(chunk).
const MAX_ESCAPE_LENGTH = 128

const ESC = 0x1b
const CSI = 0x5b // '['
const OSC = 0x5d // ']'
const BEL = 0x07
const BACKSLASH = 0x5c
const NEWLINE = 0x0a

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export interface SearchMatch {
  lineNumber: number
  text: string
}

export interface RawSlice {
  raw: string
  offset: number
}

export class RingBuffer {
  private buffer: string = ''
  private maxSize: number
  // Monotonic character offset of the first retained character.
  private startOffset: number = 0
  // Monotonic character offset one past the last character ever appended.
  private endOffset: number = 0
  // Incrementally maintained newline count so `length` stays O(1).
  private newlineCount: number = 0

  constructor(maxSize: number = DEFAULT_MAX_BUFFER_SIZE) {
    this.maxSize = maxSize
  }

  /**
   * Append data and return the monotonic character offset of the first
   * appended character. Offsets are never reset by truncation.
   */
  append(data: string): number {
    const offset = this.endOffset
    if (data.length === 0) {
      return offset
    }

    this.buffer += data
    this.endOffset += data.length
    this.newlineCount += countNewlines(data)

    if (this.buffer.length > this.maxSize) {
      this.truncate()
    }

    return offset
  }

  /**
   * Drop the oldest characters until the buffer fits, without splitting an
   * ANSI escape sequence or a UTF-16 surrogate pair at the cut boundary.
   */
  private truncate(): void {
    let start = this.buffer.length - this.maxSize
    if (start <= 0) {
      return
    }

    // Never start in the middle of a surrogate pair.
    if (
      isLowSurrogate(this.buffer.charCodeAt(start)) &&
      isHighSurrogate(this.buffer.charCodeAt(start - 1))
    ) {
      start++
    }

    // Never start in the middle of an ANSI escape sequence.
    const escapeEnd = this.escapeSequenceEndAt(start)
    if (escapeEnd > start) {
      start = escapeEnd
    }

    // Safety adjustments may push the boundary to (or past) the buffer end; in
    // that case the whole chunk is dropped rather than retaining a partial
    // escape sequence or surrogate pair.
    if (start >= this.buffer.length) {
      start = this.buffer.length
    }
    if (start <= 0) {
      return
    }

    let removed = 0
    for (let i = 0; i < start; i++) {
      if (this.buffer.charCodeAt(i) === NEWLINE) {
        removed++
      }
    }
    this.newlineCount -= removed
    this.buffer = this.buffer.slice(start)
    this.startOffset += start
  }

  /**
   * If the cut at `start` falls inside an ANSI escape sequence, return the
   * index just past that sequence. Otherwise return -1.
   */
  private escapeSequenceEndAt(start: number): number {
    const limit = Math.max(0, start - MAX_ESCAPE_LENGTH)
    let escapeIndex = -1
    for (let i = start - 1; i >= limit; i--) {
      if (this.buffer.charCodeAt(i) === ESC) {
        escapeIndex = i
        break
      }
    }
    if (escapeIndex === -1) {
      return -1
    }

    const end = this.escapeEnd(escapeIndex)
    return end > start ? end : -1
  }

  /**
   * Return the index just past the escape sequence beginning at
   * `escapeIndex`, or -1 when it cannot be resolved within the bounded window.
   */
  private escapeEnd(escapeIndex: number): number {
    const limit = Math.min(this.buffer.length, escapeIndex + MAX_ESCAPE_LENGTH)
    const next = this.buffer.charCodeAt(escapeIndex + 1)

    if (next === CSI) {
      for (let i = escapeIndex + 2; i < limit; i++) {
        const code = this.buffer.charCodeAt(i)
        if (code >= 0x40 && code <= 0x7e) {
          return i + 1
        }
      }
      return -1
    }

    if (next === OSC) {
      for (let i = escapeIndex + 2; i < limit; i++) {
        const code = this.buffer.charCodeAt(i)
        if (code === BEL) {
          return i + 1
        }
        if (code === ESC && this.buffer.charCodeAt(i + 1) === BACKSLASH) {
          return i + 2
        }
      }
      return -1
    }

    if (Number.isNaN(next)) {
      return escapeIndex + 1
    }

    return escapeIndex + 2
  }

  private splitBufferLines(): string[] {
    const lines: string[] = this.buffer.split('\n')
    // Remove empty string at end if buffer doesn't end with newline
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines
  }

  read(offset: number = 0, limit?: number): string[] {
    if (this.buffer === '') return []
    const lines: string[] = this.splitBufferLines()
    const start = Math.max(0, offset)
    const end = limit !== undefined ? start + limit : lines.length
    return lines.slice(start, end)
  }

  readRaw(): string {
    return this.buffer
  }

  /**
   * Return the suffix starting at the given absolute character offset. The
   * offset is clamped into the retained window, and the returned `offset` is
   * the absolute offset the returned suffix actually starts at.
   */
  sliceSince(since: number): RawSlice {
    const offset = Math.min(Math.max(since, this.startOffset), this.endOffset)
    return { raw: this.buffer.slice(offset - this.startOffset), offset }
  }

  search(pattern: RegExp): SearchMatch[] {
    const matches: SearchMatch[] = []
    const lines: string[] = this.splitBufferLines()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line && pattern.test(line)) {
        matches.push({ lineNumber: i + 1, text: line })
      }
    }
    return matches
  }

  get length(): number {
    if (this.buffer === '') return 0
    // `newlineCount` newlines delimit that many lines; a trailing partial line
    // (buffer not ending in newline) adds one more.
    return this.newlineCount + (this.buffer.endsWith('\n') ? 0 : 1)
  }

  get byteLength(): number {
    return this.buffer.length
  }

  /** Absolute offset of the first retained character. */
  get bufferStart(): number {
    return this.startOffset
  }

  /** Absolute offset one past the last appended character. */
  get bufferEnd(): number {
    return this.endOffset
  }

  flush(): void {
    // No-op in new implementation
  }

  clear(): void {
    this.buffer = ''
    this.newlineCount = 0
    this.startOffset = 0
    this.endOffset = 0
  }
}

function countNewlines(data: string): number {
  let count = 0
  for (let i = 0; i < data.length; i++) {
    if (data.charCodeAt(i) === NEWLINE) {
      count++
    }
  }
  return count
}
