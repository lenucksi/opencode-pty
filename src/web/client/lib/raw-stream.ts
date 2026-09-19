// Reconciles the WebSocket delta stream with the HTTP buffer snapshot so that
// the client never loses or duplicates output produced during a snapshot fetch.
//
// Ordering contract:
//   1. subscribe to the session over the WebSocket
//   2. fetch the snapshot with `since = stream.offset`
//   3. feed every `raw_data` chunk into `applyChunk`
//   4. feed the snapshot into `applySnapshot`
//
// Offsets are monotonic character offsets assigned by the server. `offset` is
// the absolute offset one past the last character currently rendered, while
// `start` is the absolute offset of the first rendered character.

export interface RawChunk {
  rawData: string
  offset: number
}

export interface RawSnapshot {
  raw: string
  offset: number
}

export type ChunkResult = 'applied' | 'duplicate' | 'gap'

export class RawStream {
  private output = ''
  private startOffset = 0
  private endOffset = 0
  private known = false

  get value(): string {
    return this.output
  }

  /** Absolute offset one past the last rendered character. */
  get offset(): number {
    return this.endOffset
  }

  /** Absolute offset of the first rendered character. */
  get start(): number {
    return this.startOffset
  }

  get initialized(): boolean {
    return this.known
  }

  reset(): void {
    this.output = ''
    this.startOffset = 0
    this.endOffset = 0
    this.known = false
  }

  /**
   * Apply an incremental WebSocket chunk. Returns:
   * - `applied` when the chunk extended the stream, seeded it, or filled a prefix,
   * - `duplicate` when the chunk was already covered,
   * - `gap` when the chunk starts beyond the rendered stream and a resync is required.
   */
  applyChunk(chunk: RawChunk): ChunkResult {
    const chunkEnd = chunk.offset + chunk.rawData.length

    if (!this.known) {
      this.output = chunk.rawData
      this.startOffset = chunk.offset
      this.endOffset = chunkEnd
      this.known = true
      return 'applied'
    }

    if (chunkEnd <= this.endOffset) {
      if (chunk.offset < this.startOffset) {
        this.output = chunk.rawData.slice(0, this.startOffset - chunk.offset) + this.output
        this.startOffset = chunk.offset
        return 'applied'
      }
      return 'duplicate'
    }

    if (chunk.offset > this.endOffset) {
      return 'gap'
    }

    let prefix = ''
    if (chunk.offset < this.startOffset) {
      prefix = chunk.rawData.slice(0, this.startOffset - chunk.offset)
      this.startOffset = chunk.offset
    }

    this.output = prefix + this.output + chunk.rawData.slice(this.endOffset - chunk.offset)
    this.endOffset = chunkEnd
    return 'applied'
  }

  /**
   * Merge a snapshot fetched with `since = offset`. Output produced during the
   * fetch is preserved because the snapshot only fills the missing prefix and
   * suffix around what has already been rendered.
   */
  applySnapshot(snapshot: RawSnapshot): void {
    const snapshotEnd = snapshot.offset + snapshot.raw.length

    if (!this.known) {
      this.output = snapshot.raw
      this.startOffset = snapshot.offset
      this.endOffset = snapshotEnd
      this.known = true
      return
    }

    if (snapshot.offset > this.endOffset) {
      // We cannot bridge the gap locally; trust the snapshot and resync.
      this.output = snapshot.raw
      this.startOffset = snapshot.offset
      this.endOffset = snapshotEnd
      return
    }

    const prefix =
      snapshot.offset < this.startOffset
        ? snapshot.raw.slice(0, this.startOffset - snapshot.offset)
        : ''
    const suffix =
      snapshotEnd > this.endOffset ? snapshot.raw.slice(this.endOffset - snapshot.offset) : ''

    if (prefix || suffix) {
      this.output = prefix + this.output + suffix
    }
    if (snapshot.offset < this.startOffset) {
      this.startOffset = snapshot.offset
    }
    if (snapshotEnd > this.endOffset) {
      this.endOffset = snapshotEnd
    }
  }
}
