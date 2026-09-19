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
//
// Alongside the reconciliation state the stream produces a `RenderIntent` for
// the terminal emulator. Consumers push that intent straight into xterm instead
// of mirroring the whole transcript in React state.

export interface RawChunk {
  rawData: string
  offset: number
}

export interface RawSnapshot {
  raw: string
  offset: number
}

export type ChunkResult = 'applied' | 'duplicate' | 'gap'

/**
 * What the emulator should do to catch up with the reconciled stream.
 * - `append`: write `data` at the current cursor position
 * - `rewrite`: discard the buffer and write `data` from scratch
 * - `reset`: discard the buffer (used on session switches)
 * - `none`: nothing changed
 */
export type RenderIntent =
  | { type: 'append'; data: string }
  | { type: 'rewrite'; data: string }
  | { type: 'reset' }
  | { type: 'none' }

const NO_RENDER: RenderIntent = { type: 'none' }

export class RawStream {
  private output = ''
  private startOffset = 0
  private endOffset = 0
  private known = false
  private lastRender: RenderIntent = NO_RENDER

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

  /** Render instruction produced by the most recent apply/reset call. */
  get render(): RenderIntent {
    return this.lastRender
  }

  reset(): void {
    this.output = ''
    this.startOffset = 0
    this.endOffset = 0
    this.known = false
    this.lastRender = { type: 'reset' }
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
      this.lastRender = { type: 'append', data: chunk.rawData }
      return 'applied'
    }

    if (chunkEnd <= this.endOffset) {
      if (chunk.offset < this.startOffset) {
        this.output = chunk.rawData.slice(0, this.startOffset - chunk.offset) + this.output
        this.startOffset = chunk.offset
        this.lastRender = { type: 'rewrite', data: this.output }
        return 'applied'
      }
      this.lastRender = NO_RENDER
      return 'duplicate'
    }

    if (chunk.offset > this.endOffset) {
      this.lastRender = NO_RENDER
      return 'gap'
    }

    let prefix = ''
    if (chunk.offset < this.startOffset) {
      prefix = chunk.rawData.slice(0, this.startOffset - chunk.offset)
      this.startOffset = chunk.offset
    }

    const appended = chunk.rawData.slice(this.endOffset - chunk.offset)
    this.output = prefix + this.output + appended
    this.endOffset = chunkEnd
    this.lastRender = prefix
      ? { type: 'rewrite', data: this.output }
      : { type: 'append', data: appended }
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
      this.lastRender = { type: 'rewrite', data: snapshot.raw }
      return
    }

    if (snapshot.offset > this.endOffset) {
      // We cannot bridge the gap locally; trust the snapshot and resync.
      this.output = snapshot.raw
      this.startOffset = snapshot.offset
      this.endOffset = snapshotEnd
      this.lastRender = { type: 'rewrite', data: snapshot.raw }
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

    if (prefix) {
      // The snapshot backfilled the head of the window; the emulator has to be
      // rebuilt because content cannot be prepended to a terminal.
      this.lastRender = { type: 'rewrite', data: this.output }
    } else if (suffix) {
      this.lastRender = { type: 'append', data: suffix }
    } else {
      this.lastRender = NO_RENDER
    }
  }
}
