import { describe, expect, it } from 'bun:test'

import { SocketWriter } from '../src/daemon/socket-writer.ts'

/**
 * A socket that accepts a fixed number of bytes per write and records what arrived.
 *
 * The real one is the same shape: `write` returns a count and the rest has to wait for
 * `drain`, which is exactly what the truncated 219 kB session list proved.
 */
class FakeSocket {
  readonly chunks: Buffer[] = []
  writes = 0
  constructor(private capacity: number) {}

  write(data: Uint8Array): number {
    this.writes += 1
    const accepted = Math.min(this.capacity, data.length)
    this.chunks.push(Buffer.from(data.subarray(0, accepted)))
    return accepted
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  setCapacity(capacity: number): void {
    this.capacity = capacity
  }
}

describe('SocketWriter', () => {
  it('writes a small message in one go', () => {
    const socket = new FakeSocket(1024)
    const writer = new SocketWriter(socket)
    writer.enqueue('hello\n')
    expect(socket.text).toBe('hello\n')
    expect(writer.pendingBytes).toBe(0)
  })

  it('keeps the remainder when the socket takes only part of a large message', () => {
    const socket = new FakeSocket(8)
    const writer = new SocketWriter(socket)
    const message = `${'x'.repeat(100)}\n`
    writer.enqueue(message)
    expect(socket.text.length).toBe(8)
    expect(writer.pendingBytes).toBe(message.length - 8)

    // `drain`: the socket has room again.
    socket.setCapacity(1024)
    writer.flush()
    expect(socket.text).toBe(message)
    expect(writer.pendingBytes).toBe(0)
  })

  it('writes everything when each call takes one byte', () => {
    const socket = new FakeSocket(1)
    const writer = new SocketWriter(socket)
    const message = '{"id":1,"result":[]}\n'
    writer.enqueue(message)
    while (writer.pendingBytes > 0) writer.flush()
    expect(socket.text).toBe(message)
  })

  it('never splits a multibyte character across a byte offset', () => {
    const socket = new FakeSocket(1)
    const writer = new SocketWriter(socket)
    const message = 'äöü 😀 日本語\n'
    writer.enqueue(message)
    while (writer.pendingBytes > 0) writer.flush()
    expect(socket.text).toBe(message)
  })

  it('queues messages in order', () => {
    const socket = new FakeSocket(3)
    const writer = new SocketWriter(socket)
    writer.enqueue('first\n')
    writer.enqueue('second\n')
    while (writer.pendingBytes > 0) writer.flush()
    expect(socket.text).toBe('first\nsecond\n')
  })

  it('leaves the queue alone while the socket accepts nothing', () => {
    const socket = new FakeSocket(0)
    const writer = new SocketWriter(socket)
    writer.enqueue('{"id":1}\n')
    expect(writer.pendingBytes).toBe(9)
    socket.setCapacity(100)
    writer.flush()
    expect(socket.text).toBe('{"id":1}\n')
  })

  it('drops what is queued once the writer is closed', () => {
    const socket = new FakeSocket(2)
    const writer = new SocketWriter(socket)
    writer.enqueue('0123456789')
    expect(writer.pendingBytes).toBeGreaterThan(0)
    writer.close()
    expect(writer.pendingBytes).toBe(0)
    const writes = socket.writes
    writer.enqueue('after close\n')
    expect(socket.writes).toBe(writes)
  })

  it('closes instead of throwing when the socket write raises', () => {
    const throwing = {
      write(): number {
        throw new Error('socket closed')
      },
    }
    const writer = new SocketWriter(throwing)
    expect(() => writer.enqueue('x\n')).not.toThrow()
    expect(writer.pendingBytes).toBe(0)
  })
})
