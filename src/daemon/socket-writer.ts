/**
 * Writing a message that does not fit in one socket buffer.
 *
 * Bun's `socket.write` returns how many bytes it accepted and drops the rest. A
 * response that carries a session list - 377 sessions is about 219 kB - therefore
 * arrived truncated, and the reader waited for a newline that never came. The fix is
 * a queue: keep the remainder and flush it again when the socket says `drain`.
 *
 * Bytes, not characters: `write` counts bytes, and slicing a JavaScript string by a
 * byte count splits multibyte characters. The queued unit is a Buffer and the offset
 * is in bytes, so a cut lands wherever the socket made it and the rest is sent whole.
 */

export interface WritableSocket {
  write(data: Uint8Array): number
}

export class SocketWriter {
  private readonly queue: Buffer[] = []
  private offset = 0
  private closed = false

  constructor(private readonly socket: WritableSocket) {}

  /** Queue a line and write as much as the socket takes right now. */
  enqueue(text: string): void {
    if (this.closed) return
    this.queue.push(Buffer.from(text, 'utf8'))
    this.flush()
  }

  /** Send what is still queued. Call from the socket's `drain` handler. */
  flush(): void {
    while (!this.closed && this.queue.length > 0) {
      const head = this.queue[0]
      if (head === undefined) return
      let written: number
      try {
        written = this.socket.write(head.subarray(this.offset))
      } catch {
        this.close()
        return
      }
      // Zero or negative means the socket is full; `drain` will call us again.
      if (!(written > 0)) return
      this.offset += written
      if (this.offset < head.length) return
      this.queue.shift()
      this.offset = 0
    }
  }

  /** Bytes still waiting, for diagnostics and tests. */
  get pendingBytes(): number {
    return this.queue.reduce(
      (total, chunk, index) => total + chunk.length - (index === 0 ? this.offset : 0),
      0
    )
  }

  close(): void {
    this.closed = true
    this.queue.length = 0
    this.offset = 0
  }
}
